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
/** Service required: the agent runtime that emits agent/request-error. */
const inject = ["agents"];

/** Settings namespace owning the user-adjustable retry budget. */
const NS = settingsNamespace("dsh-better-retry");
/** Budget bounds: the settings slider ranges 0..64, defaulting to 8. */
const MAX_RETRIES_LIMIT = 64;
const DEFAULT_MAX_RETRIES = 8;

/** Runtime schema for both composition config and the settings section. */
const Config = z.object({
	maxRetries: z.number().step(1).min(0).max(MAX_RETRIES_LIMIT).default(DEFAULT_MAX_RETRIES),
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
		// Honor a provider-supplied Retry-After. Unlike the stock plugin we do
		// NOT give up when it exceeds our own backoff cap: 429 quota/rate-limit
		// responses routinely carry Retry-After of 60s+, and the whole point of
		// this plugin is to retry every failure. The server asked for a wait, so
		// we wait exactly that long (bounded only by the timer's global cap).
		let delayMs;
		if (failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
			delayMs = Math.min(failure.providerRetryAfterMs, MAX_TIMER_DELAY_MS);
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
}

export { apply, inject, name };
