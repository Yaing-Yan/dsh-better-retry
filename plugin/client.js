// dsh-better-retry · Client half (code.client)
// -----------------------------------------------------------------------------
// Paste this file's content as `code.client` when defining the dynamic Cordis
// plugin with cordis_define. It adds one row to Settings → General with a
// slider showing the any-error retry budget. The dynamic Host half's budget
// is FIXED at 8 (no settings service in the sandbox), so the slider persists
// `dsh-better-retry.maxRetries` into settings.yaml — which the STATIC install
// reads live — and the row marks itself read-only when the namespace is not
// registered (pure dynamic run). First activation asks for user approval.
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
    var FIELD = 'maxRetries'
    var MIN = 0
    var MAX = 64
    var DEFAULT = 8

    var disposeStyles = styles.insert(
      '.dbr-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid rgba(128,128,128,.25)}' +
      '.dbr-text{display:flex;flex-direction:column;gap:4px;min-width:0}' +
      '.dbr-title{font-size:14px;line-height:22px}' +
      '.dbr-desc{font-size:12px;line-height:18px;opacity:.7;overflow-wrap:anywhere}' +
      '.dbr-control{display:flex;align-items:center;gap:10px;flex:none}' +
      '.dbr-value{min-width:2ch;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;opacity:.8}' +
      '.dbr-slider{width:160px;cursor:pointer}' +
      '.dbr-slider:disabled{opacity:.4;cursor:default}'
    )

    var disposeLocale = ctx.locale && ctx.locale.register('dsh-better-retry', {
      zh: {
        'retry.title': '失败重试次数',
        'retry.description': '模型请求失败时的自动重试次数（任意错误类型，0–64，默认 8；上下文超限与用户中止除外）。动态插件模式下固定为 8。',
      },
      en: {
        'retry.title': 'Failure retries',
        'retry.description': 'Automatic retries for a failed model request (any error kind, 0–64, default 8; context overflow and user aborts excluded). Fixed at 8 in dynamic-plugin mode.',
      },
    })

    function RetryBudgetRow(props) {
      var t = props.t
      var state = React.useState({ status: 'loading', value: DEFAULT, writable: true, revision: undefined })
      var snapshot = state[0]
      var setSnapshot = state[1]
      var generation = React.useRef(0)
      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]

      React.useEffect(function () {
        var cancelled = false
        api.settings.describe({}).then(function (response) {
          if (cancelled) return
          if (!response.result.ok) throw new Error(response.result.error.message)
          var view = response.result.value.namespaces.find(function (entry) { return entry.ns === SETTINGS_NS })
          if (view === undefined) {
            setSnapshot({ status: 'unavailable', value: DEFAULT, writable: false, revision: undefined })
          } else {
            setSnapshot({ status: 'ready', value: typeof view.value?.[FIELD] === 'number' ? view.value[FIELD] : DEFAULT, writable: response.result.value.writable !== false, revision: view.revision })
          }
        }).catch(function () {
          if (!cancelled) setSnapshot({ status: 'unavailable', value: DEFAULT, writable: false, revision: undefined })
        })
        return function () { cancelled = true }
      }, [])

      if (snapshot.status === 'unavailable') return null

      var shown = draft !== null ? draft : snapshot.value
      var disabled = snapshot.status !== 'ready' || !snapshot.writable

      function commit(next) {
        setDraft(null)
        var clamped = Math.max(MIN, Math.min(MAX, Math.round(next)))
        setSnapshot(function (prev) { return { status: 'ready', value: clamped, writable: prev.writable, revision: prev.revision } })
        var gen = ++generation.current
        api.settings.mutate({
          ns: SETTINGS_NS,
          ops: [{ op: 'set', path: [FIELD], value: clamped }],
          expectedRevision: snapshot.revision,
        }).then(function (response) {
          if (gen !== generation.current) return
          if (!response.result.ok) throw new Error(response.result.error.message)
          var view = response.result.value
          setSnapshot({ status: 'ready', value: typeof view.value?.[FIELD] === 'number' ? view.value[FIELD] : clamped, writable: true, revision: view.revision })
        }).catch(function () {})
      }

      return React.createElement('div', { className: 'dbr-row' },
        React.createElement('div', { className: 'dbr-text' },
          React.createElement('div', { className: 'dbr-title' }, t('retry.title')),
          React.createElement('div', { className: 'dbr-desc' }, t('retry.description'))),
        React.createElement('div', { className: 'dbr-control' },
          React.createElement('input', {
            type: 'range',
            className: 'dbr-slider',
            min: MIN,
            max: MAX,
            step: 1,
            value: shown,
            disabled: disabled,
            'aria-label': t('retry.title'),
            onChange: function (event) { setDraft(Number(event.target.value)) },
            onMouseUp: function (event) { commit(Number(event.currentTarget.value)) },
            onTouchEnd: function (event) { commit(Number(event.currentTarget.value)) },
            onKeyUp: function (event) {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(event.key) >= 0) commit(Number(event.currentTarget.value))
            },
          }),
          React.createElement('span', { className: 'dbr-value' }, String(shown))))
    }

    slots.inject('settings.general.item', function () {
      return slots.register({
        name: 'settings.general.item',
        id: 'better-retry',
        order: 30,
        locale: 'dsh-better-retry',
      }, RetryBudgetRow)
    })

    return function () {
      disposeStyles()
      if (disposeLocale) disposeLocale()
    }
  }
}
