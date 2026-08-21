/**
* dsh-better-retry — Host half: retry ANY model-request failure
* (regardless of error code), with the retry budget owned by the settings
* document (`dsh-better-retry` namespace, field `maxRetries`, default 8, range
* 0..64) so the client half's settings slider can adjust it without a restart.
*
* Rationale: the stock dsh-llm-retry plugin only retries failures whose code
* is listed in the provider route's retryPolicy.retryableCodes (default:
* EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT). Errors such as
* AUTH, QUOTA, INVALID_REQUEST, PI_AI_ERROR, LLM_STREAM_IDLE_TIMEOUT etc.
* previously ended the turn immediately ("本轮运行失败"). This plugin retries
* any failure except explicit user aborts and context-window overflow (the
* latter is left to the compaction plugin, which recovers by compacting
* instead of blindly repeating).
*
* The retry events appended here (`llm/retry` / `llm/retry-started`) are
* validated by the dsh-llm-retry invariant companion: mode must be "normal"
* or "always", retry numbers must increment per (turn, step, provider,
* policyKey) chain, and normal mode requires 1 <= retry <= maxRetries. This
* plugin emits mode "normal" with the live maxRetries and a policyKey that
* embeds that value, so changing the budget starts a fresh chain instead of
* colliding with an in-flight one.
*/
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Plugin identity (Cordis). */
const name = "dsh-better-retry";
/**
* Services required: the agent runtime that emits agent/request-error, and the
* web server that serves the Settings-slider read/write route. `agents` is a
* hard dependency; `webServer` is optional (settings degrade to defaults when
* the web profile does not mount one).
*/
const inject = ["agents"];

/** Settings namespace owning the user-adjustable retry budget. */
const NS = settingsNamespace("dsh-better-retry");
/** Budget bounds: the settings slider ranges 0..64, defaulting to 8. */
const MAX_RETRIES_LIMIT = 64;
const DEFAULT_MAX_RETRIES = 8;
/** 429 Retry-After wait: slider ranges 5s..120s, defaulting to 15s. */
const MIN_RETRY_AFTER_MS = 5e3;
const MAX_RETRY_AFTER_MS = 120e3;
const DEFAULT_RETRY_AFTER_MS = 15e3;

/** Runtime schema for both composition config and the settings section. */
const Config = z.object({
	maxRetries: z.number().step(1).min(0).max(MAX_RETRIES_LIMIT).default(DEFAULT_MAX_RETRIES),
	retryAfterMs: z.number().step(1).min(MIN_RETRY_AFTER_MS).max(MAX_RETRY_AFTER_MS).default(DEFAULT_RETRY_AFTER_MS),
});

/** Fixed backoff shape (mirrors the stock retry plugin defaults). */
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 1e4;
const JITTER_RATIO = 0.1;
/** Global timer cap (matches dsh-timeout): a Retry-After above this cannot be honored. */
const MAX_TIMER_DELAY_MS = 2147483647;

/** Failure codes this plugin must not retry. */
const NEVER_RETRY = new Set([
	// The user (or an upstream cancellation) aborted the request; retrying
	// would fight the abort.
	"ABORTED",
	// Context window overflow is recovered by dsh-compaction-basic, which
	// compacts and retries from the replacement surface; a blind retry of the
	// same request would fail identically.
	"CONTEXT_WINDOW_EXCEEDED",
]);

/**
* Policy key identifying one budget's retry chains inside a step. Embedding
* the budget keeps chains disjoint across budget changes and away from the
* stock plugin's provider-policy keys.
* @param {number} maxRetries - budget in force for the chain.
*/
function policyKey(maxRetries) {
	return JSON.stringify([
		"dsh-better-retry",
		maxRetries,
		INITIAL_DELAY_MS,
		MAX_DELAY_MS,
		JITTER_RATIO,
	]);
}

/**
* Compute the backoff delay for one retry, mirroring dsh-llm-retry's
* exponential-with-jitter schedule.
* @param {number} retry - 1-based retry ordinal.
* @param {() => number} random - entropy source.
* @returns {number} delay in milliseconds.
*/
function localDelay(retry, random) {
	const exponent = Math.min(retry - 1, 1024);
	const exponential = Math.min(INITIAL_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
	const jitter = 1 - JITTER_RATIO + 2 * JITTER_RATIO * random();
	return Math.min(exponential * jitter, MAX_DELAY_MS);
}

/**
* Wait that resolves false when aborted instead of throwing, so the retry
* scheduler can drop a cancelled wait silently.
* @param {number} delayMs - wait length.
* @param {AbortSignal} signal - cancellation source.
* @returns {Promise<boolean>} true when the wait completed.
*/
function cancellableDelay(delayMs, signal) {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		function onAbort() {
			clearTimeout(timer);
			resolve(false);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
* Settle a downstream recovery callback without letting its failure escape;
* downstream is the stock retry/compaction chain, whose decisions take
* precedence over ours.
* @param {() => Promise<any>} next - downstream continuation.
*/
async function settleDownstream(next) {
	try {
		return { type: "decision", decision: await next() };
	} catch (error) {
		return { type: "error", error };
	}
}

/**
* Install the any-code request recovery listener and its settings section.
* @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
* @param {unknown} config - composition-layer config (base for the section).
*/
function apply(ctx, config = {}, internals = {}) {
	const random = internals.random ?? Math.random;
	const lifetime = new AbortController();
	const active = new Set();
	/** Live budget; the settings section re-points this thunk on every change. */
	let current = Config(config);
	const budget = () => current.maxRetries;
	const retryAfter = () => current.retryAfterMs;

	function track(operation) {
		const tracked = operation.finally(() => active.delete(tracked));
		active.add(tracked);
		return tracked;
	}

	async function backoff(agent, turn, step, failure, provider, retry, retryId, delayMs, maxRetries, signal) {
		const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
		if (fusedSignal.aborted) return;
		agent.session.append("llm/retry", {
			retryId,
			turn,
			step,
			provider,
			mode: "normal",
			policyKey: policyKey(maxRetries),
			retry,
			maxRetries,
			delayMs,
			failure,
		});
		if (!await cancellableDelay(delayMs, fusedSignal)) return;
		agent.session.append("llm/retry-started", { retryId, turn, step, retry });
		return { kind: "retry" };
	}

	async function recover({ agent, turn, step, provider, failure, signal }, next) {
		// Never retry aborts or context overflow; hand them downstream (the
		// compaction plugin recovers CONTEXT_WINDOW_EXCEEDED itself).
		if (failure === void 0 || NEVER_RETRY.has(failure.code)) return next();
		// Let downstream (stock retry policy, compaction, etc.) act first; a
		// downstream retry decision wins, and a downstream recovery failure is
		// logged and overridden only when it still leaves the turn failing.
		const downstream = await settleDownstream(next);
		if (downstream.type === "error") {
			ctx.logger.warn(`dsh-better-retry: downstream recovery failed; falling back to any-code retry: %o`, downstream.error);
		} else if (downstream.type === "decision" && downstream.decision?.kind === "retry") {
			return downstream.decision;
		}
		if (signal.aborted || lifetime.signal.aborted) return;
		const maxRetries = budget();
		if (maxRetries === 0) return downstream.decision;
		// Find our own chain for this step; provider-policy chains use other
		// policyKeys and do not count toward our budget.
		const key = policyKey(maxRetries);
		const priorRetry = agent.session.events.findLast((event) => event.type === "llm/retry" && event.data.turn === turn && event.data.step === step && event.data.provider === provider && event.data.policyKey === key);
		const previousRetry = priorRetry?.data.retry ?? 0;
		if (previousRetry >= maxRetries) return downstream.decision;
		const retry = previousRetry + 1;
		const retryId = priorRetry?.data.retryId ?? randomUUID();
		// Honor a provider-supplied Retry-After, clamped to the user's
		// 429-wait window [5s, retryAfterMs]. Unlike the stock plugin we do NOT
		// give up when the server asks for more than our own backoff cap: 429
		// quota/rate-limit responses routinely carry Retry-After of 60s+, and
		// the whole point of this plugin is to retry every failure. We wait at
		// least 5s and at most the slider value (default 15s).
		let delayMs;
		if (failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
			delayMs = Math.min(Math.max(failure.providerRetryAfterMs, MIN_RETRY_AFTER_MS), Math.min(retryAfter(), MAX_TIMER_DELAY_MS));
		} else {
			delayMs = localDelay(retry, random);
		}
		return backoff(agent, turn, step, failure, provider, retry, retryId, delayMs, maxRetries, signal);
	}

	const disposeListener = ctx.on("agent/request-error", (payload, next) => {
		if (lifetime.signal.aborted) return Promise.resolve(undefined);
		return track(recover(payload, next));
	});
	ctx.effect(() => async () => {
		disposeListener();
		lifetime.abort(new Error("dsh-better-retry plugin disposed"));
		await Promise.allSettled([...active]);
	}, "dsh-better-retry: abort and drain active recovery");

	// Settings layer: the client slider writes `dsh-better-retry.maxRetries`
	// into settings.yaml; each accepted change re-points the budget thunk and
	// applies to the next failure without a restart.
	ctx.inject(["settings"], (sctx) => {
		const scope = sctx.settings.register(NS, Config, { base: Config(config) });
		const adopt = () => {
			current = scope.get();
		};
		adopt();
		scope.watch(adopt);
		sctx.effect(() => () => {
			current = Config(config);
		});
	});

	// Web route for the Settings sliders. The web client cannot read/write
	// this namespace through the settings wire API because dsh-host-apiproxy
	// only exposes allowlisted namespaces to configuration clients; this
	// package serves its own same-origin route instead. GET returns the
	// resolved section, POST { field, value } writes the user layer through
	// the settings service (schema-validated, hot-reloaded).
	ctx.inject(["webServer", "settings"], (wctx) => {
		const disposeRoute = wctx.webServer.register({
			kind: "prefix",
			path: "/dsh-better-retry",
			async handler(req, res) {
				const url = new URL(req.url ?? "/", "http://dsh");
				const pathname = url.pathname.replace(/\/+$/, "");
				if (pathname === "/dsh-better-retry/config") {
					if (req.method === "GET") {
						res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify(current));
						return;
					}
					if (req.method === "POST") {
						const body = await readRequestBody(req);
						let payload;
						try {
							payload = JSON.parse(body);
						} catch {
							res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({ error: "invalid json body" }));
							return;
						}
						const field = payload?.field;
						if (field !== "maxRetries" && field !== "retryAfterMs") {
							res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({ error: "unknown field" }));
							return;
						}
						// Re-validate through the schema so out-of-range values are
						// refused exactly like the settings service would.
						let candidate;
						try {
							candidate = Config({ ...current, [field]: payload.value });
						} catch (error) {
							res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
							return;
						}
						try {
							await wctx.settings.update(NS, { [field]: candidate[field] });
						} catch (error) {
							res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
							return;
						}
						res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify(current));
						return;
					}
				}
				res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "not found" }));
			},
		});
		wctx.effect(() => disposeRoute, "dsh-better-retry: web config route");
	});
}

/**
* Read a request body as text (bounded to 4 KiB — settings payloads are tiny).
* @param {import("node:http").IncomingMessage} req - the request.
* @returns {Promise<string>} the body text.
*/
function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 4096) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export { apply, inject, name };
