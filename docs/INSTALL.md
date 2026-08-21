# Install / update / rollback

`dsh-better-retry` can be installed two ways:

- **A. Global static plugin** (recommended): installed into the `web` profile as a bundle — every session gets the any-error retry listener and the Settings slider automatically, and it survives DSH restarts.
- **B. Dynamic Cordis plugin** (session-local): defined and activated inside a running session with `cordis_define` / `cordis_run`. Process-local and session-bound; lost on restart.

---

## A. Global static install (web profile bundle)

Same mechanism this deployment already uses for `dsh-at-file` / `dsh-better-status` / `dsh-show-picture`.

1. Get the package (this repo, a tarball of it, or a local checkout):
   ```bash
   cd "$DSH_HOME/profiles/web"     # DSH_HOME defaults to ~/.dsh
   pnpm add file:/path/to/dsh-better-retry
   # or from GitHub:
   # pnpm add https://github.com/Yaing-Yan/dsh-better-retry/archive/refs/tags/v1.0.0.tar.gz
   ```
2. Add `"dsh-better-retry"` to the `dsh.profile.bundles` array in the profile's `package.json`:
   ```json
   "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "…", "dsh-better-retry" ] } }
   ```
3. Restart the app: `dsh --profile web` (or restart via your launcher).

What it contributes (see `cordis.patch.yml`, `lib/index.js`, `lib/client.js`):
- Host: one `agent/request-error` listener that retries any model-request failure (except `ABORTED` and `CONTEXT_WINDOW_EXCEEDED`) with durable `llm/retry` events and exponential backoff, bounded by the `dsh-better-retry.maxRetries` settings field (default 8, max 64).
- Client: a Settings → General row (`settings.general.item`, id `better-retry`) with a 0–64 slider that writes that field live.

To update: replace the package in the profile (`pnpm add` the new version, e.g. a new GitHub tag), keep the bundle entry, and restart.

---

## B. Dynamic Cordis plugin (session-local)

### 1. First activation

1. Call `cordis_define` with `kind: "new"` and any 3–6 letter prefix (e.g. `retry`):
   - `code.host` ← full content of [`../plugin/host.js`](../plugin/host.js)
   - `code.client` ← full content of [`../plugin/client.js`](../plugin/client.js)
2. The tool returns a `pluginId` (e.g. `retry-1`) and `packageId` (e.g. `pkg-1`).
3. Call `cordis_run` with those ids and `mode: "run"`.
4. The **Client half requires user approval** on first activation. If the run returns `awaiting-approval`, the user must click *Allow* in the UI. Do not claim the plugin is running while it is still pending.
5. Once running, every model-request failure in this session is retried up to 8 times (dynamic mode is fixed at 8 — the sandboxed Host half has no `settings` service).

### 2. Updating to a new version

1. `cordis_define` with `kind: "existing"` and the same `pluginId`, with the updated `code.host` / `code.client`. This appends a new immutable `packageId`; old versions are never overwritten.
2. `cordis_run` with the new `packageId` and `mode: "update"`.

### 3. Rollback

- Roll back to the last successful version: `cordis_run` with `currentPackageId` and `mode: "run"`.

### 4. Stopping / removing

- Pause the plugin (keep definitions and grants): `cordis_stop { pluginId }`.
- Permanently delete it: `cordis_undefine { pluginId }`.

---

## Verifying it works

Ask the agent something while its provider is failing (or just watch a real failure): the conversation shows "正在重试模型请求（n/8）· Xs" / "Retrying model request (n/8) · Xs" rows. `n` counts up to the configured budget instead of the turn failing on the first error.
