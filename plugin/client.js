// dsh-better-retry · Client half (code.client)
// -----------------------------------------------------------------------------
// Paste this file's content as `code.client` when defining the dynamic Cordis
// plugin with cordis_define. It adds two rows to Settings → General with
// sliders: the any-error retry budget and the 429 Retry-After wait (seconds).
// The dynamic Host half's budget is FIXED at 8 and the 429 wait at 15s (no
// settings service in the sandbox); the sliders persist
// `dsh-better-retry.maxRetries` / `dsh-better-retry.retryAfterMs` into
// settings.yaml, which the STATIC install reads live — and the rows mark
// themselves read-only when the namespace is not registered (pure dynamic
// run). First activation asks for user approval.
//
// Client builtins used: React, ctx (slots/locale/connection services).
// -----------------------------------------------------------------------------

return {
  apply(ctx) {
    var slots = ctx.get('slots')
    if (slots === undefined) return
    var connection = ctx.get('connection')
    var api = connection && connection.api
    if (api === undefined) return

    var SETTINGS_NS = 'dsh-better-retry'

    var disposeStyles = styles.insert(
      '.dbr-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid rgba(128,128,128,.25)}' +
      '.dbr-text{display:flex;flex-direction:column;gap:4px;min-width:0}' +
      '.dbr-title{font-size:14px;line-height:22px}' +
      '.dbr-desc{font-size:12px;line-height:18px;opacity:.7;overflow-wrap:anywhere}' +
      '.dbr-control{display:flex;align-items:center;gap:10px;flex:none}' +
      '.dbr-value{min-width:3ch;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;opacity:.8}' +
      '.dbr-slider{width:160px;cursor:pointer}' +
      '.dbr-slider:disabled{opacity:.4;cursor:default}'
    )

    var disposeLocale = ctx.locale && ctx.locale.register('dsh-better-retry', {
      zh: {
        'retry.title': '失败重试次数',
        'retry.description': '模型请求失败时的自动重试次数（任意错误类型，0–64，默认 8；上下文超限与用户中止除外）。动态插件模式下固定为 8。',
        'delay.title': '429 等待（秒）',
        'delay.description': '服务端返回 Retry-After（429 限流/配额）时最多等待多久再重试，5–120 秒，默认 15 秒。动态插件模式下固定为 15 秒。',
      },
      en: {
        'retry.title': 'Failure retries',
        'retry.description': 'Automatic retries for a failed model request (any error kind, 0–64, default 8; context overflow and user aborts excluded). Fixed at 8 in dynamic-plugin mode.',
        'delay.title': '429 wait (s)',
        'delay.description': 'How long to honor a provider Retry-After (429 rate-limit/quota) before retrying, 5–120 s, default 15 s. Fixed at 15 s in dynamic-plugin mode.',
      },
    })

    function readSettings() {
      return api.settings.describe({}).then(function (response) {
        if (!response.result.ok) throw new Error(response.result.error.message)
        var view = response.result.value.namespaces.find(function (entry) { return entry.ns === SETTINGS_NS })
        if (view === undefined) return { available: false, writable: false }
        return { available: true, writable: response.result.value.writable !== false, value: view.value, revision: view.revision }
      })
    }

    function writeField(revision, field, value) {
      return api.settings.mutate({
        ns: SETTINGS_NS,
        ops: [{ op: 'set', path: [field], value: value }],
        expectedRevision: revision,
      }).then(function (response) {
        if (!response.result.ok) throw new Error(response.result.error.message)
        return response.result.value
      })
    }

    function makeSliderRow(spec) {
      return function SliderRow(props) {
        var t = props.t
        var state = React.useState({ status: 'loading', value: spec.defaultValue, writable: true, revision: undefined })
        var snapshot = state[0]
        var setSnapshot = state[1]
        var generation = React.useRef(0)
        var draftState = React.useState(null)
        var draft = draftState[0]
        var setDraft = draftState[1]

        React.useEffect(function () {
          var cancelled = false
          readSettings().then(function (result) {
            if (cancelled) return
            if (!result.available) setSnapshot({ status: 'unavailable', value: spec.defaultValue, writable: false, revision: undefined })
            else {
              var raw = result.value && typeof result.value[spec.field] === 'number' ? result.value[spec.field] : spec.defaultValue
              setSnapshot({ status: 'ready', value: raw, writable: result.writable, revision: result.revision })
            }
          }).catch(function () {
            if (!cancelled) setSnapshot({ status: 'unavailable', value: spec.defaultValue, writable: false, revision: undefined })
          })
          return function () { cancelled = true }
        }, [])

        if (snapshot.status === 'unavailable') return null

        var shown = draft !== null ? draft : spec.toDisplay(snapshot.value)
        var disabled = snapshot.status !== 'ready' || !snapshot.writable

        function commit(next) {
          setDraft(null)
          var clamped = Math.max(spec.min, Math.min(spec.max, Math.round(next)))
          var stored = spec.toValue(clamped)
          setSnapshot(function (prev) { return { status: 'ready', value: stored, writable: prev.writable, revision: prev.revision } })
          var gen = ++generation.current
          writeField(snapshot.revision, spec.field, stored).then(function (view) {
            if (gen !== generation.current) return
            var raw = view.value && typeof view.value[spec.field] === 'number' ? view.value[spec.field] : stored
            setSnapshot({ status: 'ready', value: raw, writable: true, revision: view.revision })
          }).catch(function () {})
        }

        return React.createElement('div', { className: 'dbr-row' },
          React.createElement('div', { className: 'dbr-text' },
            React.createElement('div', { className: 'dbr-title' }, t(spec.titleKey)),
            React.createElement('div', { className: 'dbr-desc' }, t(spec.descKey))),
          React.createElement('div', { className: 'dbr-control' },
            React.createElement('input', {
              type: 'range',
              className: 'dbr-slider',
              min: spec.min,
              max: spec.max,
              step: spec.step,
              value: shown,
              disabled: disabled,
              'aria-label': t(spec.titleKey),
              onChange: function (event) { setDraft(Number(event.target.value)) },
              onMouseUp: function (event) { commit(Number(event.currentTarget.value)) },
              onTouchEnd: function (event) { commit(Number(event.currentTarget.value)) },
              onKeyUp: function (event) {
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(event.key) >= 0) commit(Number(event.currentTarget.value))
              },
            }),
            React.createElement('span', { className: 'dbr-value' }, String(shown))))
      }
    }

    var RetryBudgetRow = makeSliderRow({
      field: 'maxRetries', min: 0, max: 64, step: 1, defaultValue: 8,
      toDisplay: function (v) { return String(v) },
      toValue: function (v) { return v },
      titleKey: 'retry.title', descKey: 'retry.description',
    })

    var RetryDelayRow = makeSliderRow({
      field: 'retryAfterMs', min: 5, max: 120, step: 1, defaultValue: 15000,
      toDisplay: function (v) { return String(Math.round(v / 1000)) },
      toValue: function (s) { return s * 1000 },
      titleKey: 'delay.title', descKey: 'delay.description',
    })

    slots.inject('settings.general.item', function () {
      return slots.register({
        name: 'settings.general.item',
        id: 'better-retry',
        order: 30,
        locale: 'dsh-better-retry',
      }, RetryBudgetRow)
    })
    slots.inject('settings.general.item', function () {
      return slots.register({
        name: 'settings.general.item',
        id: 'better-retry-delay',
        order: 31,
        locale: 'dsh-better-retry',
      }, RetryDelayRow)
    })

    return function () {
      disposeStyles()
      if (disposeLocale) disposeLocale()
    }
  }
}
