// dsh-better-retry — Client half (static/global install)
// -----------------------------------------------------------------------------
// Served to the browser by the web client module loader (window.__ModuleLoader__).
// Registers one row in Settings → General ("settings.general.item") with a
// slider that controls the Host half's any-error retry budget
// (settings namespace `dsh-better-retry`, field `maxRetries`, 0..64, default 8).
//
// The row reads and writes the settings document directly through the wire
// face (ctx.get('connection').api.settings.describe / mutate) so it needs no
// product-side allowlist entry and no save button: every slider release
// persists immediately.

window.__ModuleLoader__.load({ id: 'dsh-better-retry', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var React = require('react');

exports.name = 'dsh-better-retry';
exports.inject = ['slots'];

var SETTINGS_NS = 'dsh-better-retry';
var FIELD = 'maxRetries';
var MIN = 0;
var MAX = 64;
var DEFAULT = 8;

// ===== stylesheet (injected once, idempotent across HMR) =====
var STYLE_ID = 'dsh-better-retry-style';
var CSS = [
  '.dbr-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}',
  '.dbr-text{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dbr-title{color:var(--dsw-alias-label-primary,#111);font-size:14px;line-height:22px}',
  '.dbr-desc{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
  '.dbr-control{display:flex;align-items:center;gap:10px;flex:none}',
  '.dbr-value{min-width:2ch;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;color:var(--dsw-alias-label-secondary,#555)}',
  '.dbr-slider{width:160px;accent-color:var(--dsw-alias-brand-primary,#4f7cff);cursor:pointer}',
  '.dbr-slider:disabled{opacity:.4;cursor:default}',
].join('\n');

function adoptStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  var el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ===== settings access =====
// Reads the resolved namespace value via settings.describe; writes one field
// via settings.mutate with revision fencing. Latest gesture wins: a stale
// response is dropped by comparing request generations.
function readBudget(api) {
  return api.settings.describe({}).then(function (response) {
    if (!response.result.ok) throw new Error(response.result.error.message);
    var view = response.result.value.namespaces.find(function (entry) { return entry.ns === SETTINGS_NS; });
    if (view === undefined) return { available: false, writable: false };
    var value = view.value && typeof view.value[FIELD] === 'number' ? view.value[FIELD] : DEFAULT;
    return { available: true, writable: response.result.value.writable !== false, value: value, revision: view.revision };
  });
}

function writeBudget(api, revision, value) {
  return api.settings.mutate({
    ns: SETTINGS_NS,
    ops: [{ op: 'set', path: [FIELD], value: value }],
    expectedRevision: revision,
  }).then(function (response) {
    if (!response.result.ok) throw new Error(response.result.error.message);
    var view = response.result.value;
    return { available: true, writable: true, value: view.value && typeof view.value[FIELD] === 'number' ? view.value[FIELD] : value, revision: view.revision };
  });
}

// ===== settings row =====
function RetryBudgetRow(props) {
  var api = props.api;
  var state = React.useState({ status: 'loading', value: DEFAULT, writable: true, revision: undefined });
  var snapshot = state[0];
  var setSnapshot = state[1];
  var generation = React.useRef(0);
  var sliderDraft = React.useState(null);
  var draft = sliderDraft[0];
  var setDraft = sliderDraft[1];

  React.useEffect(function () {
    adoptStyles();
    var cancelled = false;
    readBudget(api).then(function (result) {
      if (cancelled) return;
      if (!result.available) setSnapshot({ status: 'unavailable', value: DEFAULT, writable: false, revision: undefined });
      else setSnapshot({ status: 'ready', value: result.value, writable: result.writable, revision: result.revision });
    }).catch(function () {
      if (!cancelled) setSnapshot({ status: 'unavailable', value: DEFAULT, writable: false, revision: undefined });
    });
    return function () { cancelled = true; };
  }, [api]);

  if (snapshot.status === 'unavailable') return null;

  var shown = draft !== null ? draft : snapshot.value;
  var disabled = snapshot.status !== 'ready' || !snapshot.writable;

  function commit(next) {
    setDraft(null);
    var clamped = Math.max(MIN, Math.min(MAX, Math.round(next)));
    setSnapshot(function (prev) { return { status: 'ready', value: clamped, writable: prev.writable, revision: prev.revision }; });
    var gen = ++generation.current;
    writeBudget(api, snapshot.revision, clamped).then(function (result) {
      if (gen !== generation.current) return;
      setSnapshot({ status: 'ready', value: result.value, writable: result.writable, revision: result.revision });
    }).catch(function () {
      if (gen !== generation.current) return;
      // Re-read to recover the authoritative value after a refused write.
      readBudget(api).then(function (result) {
        if (gen !== generation.current || !result.available) return;
        setSnapshot({ status: 'ready', value: result.value, writable: result.writable, revision: result.revision });
      });
    });
  }

  return React.createElement('div', { className: 'dbr-row' },
    React.createElement('div', { className: 'dbr-text' },
      React.createElement('div', { className: 'dbr-title' }, props.t('retry.title')),
      React.createElement('div', { className: 'dbr-desc' }, props.t('retry.description'))),
    React.createElement('div', { className: 'dbr-control' },
      React.createElement('input', {
        type: 'range',
        className: 'dbr-slider',
        min: MIN,
        max: MAX,
        step: 1,
        value: shown,
        disabled: disabled,
        'aria-label': props.t('retry.title'),
        onChange: function (event) { setDraft(Number(event.target.value)); },
        onMouseUp: function (event) { commit(Number(event.currentTarget.value)); },
        onTouchEnd: function (event) { commit(Number(event.currentTarget.value)); },
        onKeyUp: function (event) {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End') commit(Number(event.currentTarget.value));
        },
      }),
      React.createElement('span', { className: 'dbr-value' }, String(shown))));
}

// ===== registration =====
exports.apply = function apply(ctx) {
  var slots = ctx.get('slots');
  if (slots === undefined) return;
  var api = ctx.get('connection') && ctx.get('connection').api;
  if (api === undefined) return;
  ctx.effect(function () {
    return ctx.locale.register('dsh-better-retry', {
      zh: {
        'retry.title': '失败重试次数',
        'retry.description': '模型请求失败时的自动重试次数（任意错误类型，0–64，默认 8；上下文超限与用户中止除外）。',
      },
      en: {
        'retry.title': 'Failure retries',
        'retry.description': 'Automatic retries for a failed model request (any error kind, 0–64, default 8; context overflow and user aborts excluded).',
      },
    });
  }, 'dsh-better-retry: dictionaries');
  slots.inject('settings.general.item', function () {
    return slots.register({
      name: 'settings.general.item',
      id: 'better-retry',
      order: 30,
      locale: 'dsh-better-retry',
      inject: function () { return { api: api }; },
    }, RetryBudgetRow);
  });
};

return module.exports; } });
