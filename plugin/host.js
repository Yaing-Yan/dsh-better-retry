// dsh-better-retry · Host half (code.host)
// -----------------------------------------------------------------------------
// Paste this file's content as `code.host` when defining the dynamic Cordis
// plugin with cordis_define. It retries ANY model-request failure (any error
// code) up to 8 times with exponential backoff, mirroring the durable
// scheduling of the stock dsh-llm-retry plugin — which only retries the
// provider policy's retryableCodes and used to end the turn immediately
// ("本轮运行失败") on errors like AUTH / QUOTA / INVALID_REQUEST /
// PI_AI_ERROR / stream idle timeouts.
//
// Deliberately NOT retried: ABORTED (user cancel) and
// CONTEXT_WINDOW_EXCEEDED (handled by the compaction plugin).
//
// Dynamic-plugin limits: no `settings` service access and no
// crypto.randomUUID in the sandbox, so the budget is fixed at 8 here and the
// retry id is minted from Math.random(). The static install (lib/) adds the
// Settings → General slider (0–64, default 8).
//
// Declared inject: ['agents'] (agent/request-error rides the agents runtime).
// -----------------------------------------------------------------------------

return {
  inject: ['agents'],
  apply(ctx) {
    var MAX_RETRIES = 8
    var INITIAL_DELAY_MS = 500
    var MAX_DELAY_MS = 1e4
    var JITTER_RATIO = 0.1
    var NEVER_RETRY = { ABORTED: true, CONTEXT_WINDOW_EXCEEDED: true }
    var POLICY_KEY = JSON.stringify(['dsh-better-retry/dynamic', MAX_RETRIES, INITIAL_DELAY_MS, MAX_DELAY_MS, JITTER_RATIO])

    function retryId() {
      // crypto.randomUUID is not in the sandbox; the id only needs to be
      // unique per retry chain.
      return 'dbr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
    }

    function localDelay(retry) {
      var exponent = Math.min(retry - 1, 1024)
      var exponential = Math.min(INITIAL_DELAY_MS * Math.pow(2, exponent), MAX_DELAY_MS)
      var jitter = 1 - JITTER_RATIO + 2 * JITTER_RATIO * Math.random()
      return Math.min(exponential * jitter, MAX_DELAY_MS)
    }

    function cancellableDelay(delayMs, signal) {
      if (signal.aborted) return Promise.resolve(false)
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        }, delayMs)
        function onAbort() {
          clearTimeout(timer)
          resolve(false)
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }

    function settleDownstream(next) {
      return next().then(
        function (decision) { return { type: 'decision', decision: decision } },
        function (error) { return { type: 'error', error: error } }
      )
    }

    function backoff(agent, turn, step, failure, provider, retry, id, delayMs, signal) {
      if (signal.aborted) return Promise.resolve(undefined)
      agent.session.append('llm/retry', {
        retryId: id,
        turn: turn,
        step: step,
        provider: provider,
        mode: 'normal',
        policyKey: POLICY_KEY,
        retry: retry,
        maxRetries: MAX_RETRIES,
        delayMs: delayMs,
        failure: failure,
      })
      return cancellableDelay(delayMs, signal).then(function (completed) {
        if (!completed) return undefined
        agent.session.append('llm/retry-started', { retryId: id, turn: turn, step: step, retry: retry })
        return { kind: 'retry' }
      })
    }

    function recover(payload, next) {
      var failure = payload.failure
      var signal = payload.signal
      // Never retry aborts or context overflow; hand them downstream (the
      // compaction plugin recovers CONTEXT_WINDOW_EXCEEDED itself).
      if (failure === undefined || NEVER_RETRY[failure.code] === true) return next()
      return settleDownstream(next).then(function (downstream) {
        // A downstream (stock retry / compaction) retry decision wins.
        if (downstream.type === 'decision' && downstream.decision && downstream.decision.kind === 'retry') return downstream.decision
        if (downstream.type === 'error') console.error('dsh-better-retry: downstream recovery failed; falling back to any-code retry:', downstream.error)
        if (signal.aborted) return undefined
        var events = payload.agent.session.events
        var prior = undefined
        for (var i = events.length - 1; i >= 0; i--) {
          var e = events[i]
          if (e.type === 'llm/retry' && e.data.turn === payload.turn && e.data.step === payload.step && e.data.provider === payload.provider && e.data.policyKey === POLICY_KEY) { prior = e; break }
        }
        var previousRetry = prior ? prior.data.retry : 0
        if (previousRetry >= MAX_RETRIES) return downstream.decision
        var retry = previousRetry + 1
        var id = prior ? prior.data.retryId : retryId()
        // Honor provider Retry-After without giving up when it is long: 429
        // quota/rate-limit responses routinely ask for 60s+, and the point of
        // this plugin is to retry every failure. Wait exactly what the server
        // asked (bounded only by the global timer cap ~24.8 days).
        var MAX_TIMER_DELAY_MS = 2147483647
        var delayMs
        if (failure.providerRetryAfterMs !== undefined && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
          delayMs = Math.min(failure.providerRetryAfterMs, MAX_TIMER_DELAY_MS)
        } else {
          delayMs = localDelay(retry)
        }
        return backoff(payload.agent, payload.turn, payload.step, failure, payload.provider, retry, id, delayMs, signal)
      })
    }

    var dispose = ctx.on('agent/request-error', function (payload, next) {
      return recover(payload, next)
    })
    return function () { dispose() }
  }
}
