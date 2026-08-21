# dsh-better-retry 🔁

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Cordis plugin that retries **any** model-request failure — whatever the error code — with durable, backoff-scheduled retries, plus **Settings → General sliders** to tune the retry budget (0–64, default 8) and the 429 wait (5–120 s, default 15 s) live.
> 一个 DSH（DeepSeek Harness）Cordis 插件：无论报什么错都自动重试模型请求（持久化 + 指数退避），并在 设置 → 常规 里提供滑块实时调整重试次数（0–64，默认 8）与 429 等待时长（5–120 秒，默认 15 秒）。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Cordis%20Plugin-blueviolet)](https://github.com/deepseek-ai/deepseek-harness)

## ✨ Why / 为什么需要它

The stock `dsh-llm-retry` plugin only retries failures whose code appears in the provider route's `retryPolicy.retryableCodes` (default: `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`). Everything else — `AUTH`, `QUOTA`, `INVALID_REQUEST`, `PI_AI_ERROR`, `LLM_STREAM_IDLE_TIMEOUT`, … — ended the turn immediately with "本轮运行失败".

内置的 `dsh-llm-retry` 只重试 provider 策略里列出的错误码（默认：空响应、限流、5xx、超时、传输错误）。其它错误（鉴权、配额、无效请求、流空闲超时……）一遇即终，直接「本轮运行失败」。本插件把这张白名单变成"全量重试"。

- **Any error code** — retries every failure class, capped by your budget.
- **Durable & visible** — appends the same `llm/retry` / `llm/retry-started` events as the stock plugin, so the chat UI shows "正在重试模型请求（n/N）· Xs" and sessions stay replay-safe.
- **Sliders in Settings** — Settings → General → "失败重试次数 / Failure retries" (0–64, default 8) and "429 等待（秒） / 429 wait (s)" (5–120, default 15), persisted to `settings.yaml`, apply to the *next* failure with no restart.
- **Two deliberate exceptions** — `ABORTED` (user cancel) and `CONTEXT_WINDOW_EXCEEDED` (handled by the compaction plugin) are never retried.
- **Plays well with stock retry** — a downstream retry/compaction decision always wins; this plugin only recovers failures nobody else claimed.

## 🧩 How it works / 工作原理

| Half | Role |
| --- | --- |
| **Host** (`lib/index.js`) | Listens on the agent loop's `agent/request-error` waterfall. For any failure not in the never-retry set and not already recovered downstream, it appends a durable `llm/retry` event, waits out exponential backoff (500 ms → 10 s cap, 10% jitter) — or, for a failure carrying `Retry-After` (429 rate-limit/quota), the server-requested wait clamped into the user's 429 window [5 s, `retryAfterMs`] — appends `llm/retry-started`, and returns `{ kind: "retry" }` so the loop re-issues the request. The settings live in the `dsh-better-retry` namespace (`maxRetries` default 8 max 64, `retryAfterMs` default 15 s range 5–120 s), hot-reloaded per change. |
| **Client** (`lib/client.js`) | Registers two `settings.general.item` rows: range sliders that read/write the Host half's same-origin route `/dsh-better-retry/config` (the settings wire API only serves apiproxy-allowlisted namespaces, so the Host serves its own route through the settings service) — every release persists `dsh-better-retry.maxRetries` / `retryAfterMs` into `settings.yaml` immediately. |

```
model request fails (any code)
        │
        ▼
agent/request-error (waterfall)
        │  downstream first: stock retry / compaction decide?
        ▼
  never-retry? ── ABORTED / CONTEXT_WINDOW_EXCEEDED ──► pass through
        │
        ▼
  append llm/retry (durable) ──► backoff ──► llm/retry-started ──► loop retries
        │                                                         (max: slider value)
        ▼
  budget exhausted ──► original failure surfaces ("本轮运行失败")
```

## 📦 Install / 安装

### A. Global static plugin (recommended — survives restarts)

```bash
cd "$DSH_HOME/profiles/web"          # DSH_HOME defaults to ~/.dsh
pnpm add https://github.com/Yaing-Yan/dsh-better-retry/archive/refs/tags/v1.0.0.tar.gz
# then add "dsh-better-retry" to the "dsh.profile.bundles" array in package.json
dsh --profile web                    # restart the app
```

That is exactly how `dsh-at-file` / `dsh-better-status` / `dsh-show-picture` are installed. The Host half registers the retry listener; the Client half is served as a web module (`/plugins/dsh-better-retry/client.js`) and adds the slider row to Settings → General.

### B. Dynamic Cordis plugin (session-local)

The plugin can also be created in a single session with `cordis_define` (kind `new`):
- `code.host` ← paste the content of [`plugin/host.js`](plugin/host.js)
- `code.client` ← paste the content of [`plugin/client.js`](plugin/client.js)

then activate with `cordis_run` (mode `run`). First activation of the Client half asks for **user approval** in the UI. Dynamic plugins are process-local: they do **not** survive a DSH restart and belong to the session that created them. In dynamic mode the budget is **fixed at 8** (the sandbox has no `settings` service); the slider still persists the value for the static install.

Full step-by-step (including upgrades and rollback) is in [`docs/INSTALL.md`](docs/INSTALL.md).

## 🎚 Configuration / 配置

| Where | What | Default | Range |
| --- | --- | --- | --- |
| Settings → General → 失败重试次数 | `dsh-better-retry.maxRetries` | 8 | 0–64 |
| Settings → General → 429 等待（秒） | `dsh-better-retry.retryAfterMs` | 15 s | 5–120 s |
| `~/.dsh/settings.yaml` → `dsh-better-retry:` → `maxRetries` / `retryAfterMs` | same, hand-editable | 8 / 15000 ms | 0–64 / 5000–120000 ms |

- `0` disables the any-code retry entirely (stock policy still applies).
- Changes apply to the **next** failure; an in-flight retry chain keeps the budget it started with (the chain's `policyKey` embeds the budget).
- Backoff: 500 ms initial, doubling, 10 s cap, ±10% jitter.
- A provider `Retry-After` (429 quota/rate-limit) is honored as the wait, clamped into `[5 s, retryAfterMs]` — never skipped, so quota errors are retried up to the budget (e.g. 60 s Retry-After with the default 15 s cap waits 15 s per retry).

## ⚠️ Notes / 说明

- Retrying an `AUTH`/`QUOTA` failure only helps for transient blips — a permanently bad key or empty balance will simply fail 9 times (1 + 8 retries) before surfacing.
- Context-window overflow is recovered by `dsh-compaction-basic` (compact, then retry from the replacement surface), not by blind repetition.
- Session replay stays valid: emitted events satisfy the stock `llm-retry` invariants (mode, ascending retry numbers, per-chain retryId).

## 📁 Repository layout / 目录结构

```
dsh-better-retry/
├── lib/
│   ├── index.js         # Host half (any-error retry + settings section) — static install
│   └── client.js        # Client half (Settings slider) — served as a web module
├── plugin/
│   ├── host.js          # Host half — paste as code.host (dynamic; budget fixed at 8)
│   └── client.js        # Client half — paste as code.client (dynamic)
├── docs/
│   └── INSTALL.md       # Step-by-step install / update / rollback
├── cordis.patch.yml     # Bundle patch: inserts the dsh-better-retry row
├── dsh.plugin.json      # Plugin metadata (entry + client platform)
├── package.json
└── LICENSE
```

## 📄 License / 许可证

[MIT](LICENSE) © 2026 dsh-better-retry contributors
