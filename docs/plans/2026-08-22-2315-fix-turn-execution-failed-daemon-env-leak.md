# Implementation Plan: Fix "Turn execution failed reason=unknown retryable=false"

## Status
- Status: Completed
- Created: 2026-08-22 23:15
- Approved: Yes (2026-08-22)
- Completed: 2026-08-23

## Request Summary

ZCode subagent turns fail mid-work with:

```text
Turn execution failed
provider=52fb78c2-e540-453b-b790-5d26a4e66f55 model=gpt-5.6-sol request=... reason=unknown retryable=false
```

and the run does not auto-retry. Diagnose the root cause and fix it so the proxy serves real ZCode traffic reliably.

## Root Cause (Verified)

The provider UUID maps to the `gpt-oauth` provider:

```text
52fb78c2-e540-453b-b790-5d26a4e66f55 -> gpt-oauth
baseURL= http://127.0.0.1:8787/v1
models= gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna
```

The process currently owning port 8787 is a **stale test daemon leaked by the cache-settings test**:

```text
PID 34274  node (LISTEN 127.0.0.1:8787)
HOME=/var/folders/.../T/gpt-settings-780V9l
NODE_ENV=test
GPT_OAUTH_HOME=/var/folders/.../T/gpt-settings-780V9l
healthz: {"ok":true,"version":"0.2.4","loggedIn":false,"cacheMissNotices":true,"modelCount":3}
```

Meanwhile the real token store is valid:

```text
~/.zcode/gpt-oauth/auth.json  valid=true expires=2026-09-01 email=kvucodeassit@gmail.com
```

Because the daemon was spawned with `GPT_OAUTH_HOME`/`HOME` pointing at a temp test dir, it reads the temp token store (empty) and answers every real backend request with `401 re-login required`. ZCode treats that as `reason=unknown retryable=false`, so the turn aborts and does not retry.

### How the leak happens

- `test/cache-settings.test.js` starts the server with `--mcp-only` and `GPT_OAUTH_HOME=<temp>`.
- The new MCP tool `gpt_cache_miss_notices` persists the setting and then calls `restartDaemonForCacheSetting()` → `ensureDaemon()` → `spawnDaemon()`, which **ignores `MCP_ONLY`** and spawns a detached daemon on the default port 8787.
- `spawnDaemon()` inherits the parent's environment, so the daemon gets the test `HOME`/`GPT_OAUTH_HOME`/`NODE_ENV=test`, binds the production port 8787, and shadows the real proxy.
- The daemon survives the test (detached + `child.unref()`), so it remains after `npm test` finishes.

References in `server/server.js`: `gpt_cache_miss_notices` handler (~789-803), `restartDaemonForCacheSetting` (~386-397), `ensureDaemon`/`spawnDaemon` (~423-440), `--mcp-only` guard pattern already used in `gpt_status` (~815-818).

## Proposed Solution

### Code fixes

1. **Never spawn the production daemon from test/MCP-only contexts.**
   - In `gpt_cache_miss_notices`, skip daemon restart (persist settings only) when `MCP_ONLY` is set — mirroring the `gpt_status` guard.
   - In `restartDaemonForCacheSetting`, do nothing to the daemon when `MCP_ONLY`.

2. **Harden `spawnDaemon()` environment.**
   - Build an explicit clean env for the detached daemon: start from `process.env`, then force `NODE_ENV` to a non-test value (e.g. delete it or set `"production"`), remove `GPT_OAUTH_HOME` and `GPT_OAUTH_PROXY_PORT` test overrides unless they were explicitly set by the caller for a real purpose (they are only test hooks), and always use the real `HOME` for token discovery when `HOME` was overridden by tests.
   - Consequence: any daemon that owns port 8787 always reads the real `~/.zcode/gpt-oauth/auth.json` and `settings.json`.

3. **Defensive daemon self-check (optional but recommended).**
   - On daemon startup, if `NODE_ENV === 'test'` and the process is serving HTTP on the default port 8787 without an explicit test port override, refuse to bind or log a loud warning. This makes a future leak fail loudly instead of silently shadowing production.

4. **Test suite hardening.**
   - `test/cache-settings.test.js`: after the `gpt_cache_miss_notices` test, assert that no daemon process was spawned (e.g. port 8787 not listening, or `tools/list`/behavior unchanged). Use `--mcp-only` semantics so tests never touch the production port.
   - Add a regression test that `gpt_cache_miss_notices` in `--mcp-only` mode persists the setting but does not start a daemon.

### Operational remediation (after approval)

1. Kill the leaked test daemon on port 8787 (`POST /shutdown` with `x-gpt-oauth-shutdown: 1`, then verify the port is free).
2. Start a clean daemon from the real environment (via `node server/server.js --daemon` or by triggering the plugin's `ensureDaemon` from a normal MCP process) and verify:

```json
{"ok":true,"version":"0.2.5","loggedIn":true,"modelCount":3}
```

3. Verify a real streaming call through the proxy succeeds (gpt-5.6-luna via `curl`), confirming `loggedIn:true` and no 401.

## Workstreams

### Workstream 1: Server hardening and tests

- Agent: `worker`
- Owned files:
  - `server/server.js`
  - `test/cache-settings.test.js`
  - `test/cache-integration.test.js` (only if needed for regression)
- Implementation steps:
  1. Add `MCP_ONLY` guards to `gpt_cache_miss_notices` and `restartDaemonForCacheSetting`.
  2. Clean the daemon environment in `spawnDaemon()` (strip test-only overrides, force real HOME for token discovery).
  3. Add loud refusal/guard when a test-env process would serve the production port.
  4. Add/extend tests as described.
- Verification:
  - `node --check server/server.js`
  - `node --test test/cache-settings.test.js test/cache-integration.test.js`
  - `npm test`
  - Confirm no daemon left on 8787 after `npm test`.

### Workstream 2: Operational cleanup, docs, version

- Agent: `worker`
- Owned files:
  - `README.md`
  - `commands/gpt-oauth/status.md`
  - version metadata files
- Implementation steps:
  1. After Workstream 1 passes, run the operational remediation steps (kill stale daemon, start clean daemon, verify `loggedIn:true`).
  2. Document the daemon environment hygiene and the `--mcp-only` guarantee in README/status.
  3. Bump version to `0.2.6` across all metadata after tests pass.
- Verification:
  - `curl -s http://127.0.0.1:8787/healthz` shows `loggedIn:true` and `version:0.2.6`.
  - A real streaming request succeeds.
  - JSON/version consistency checks pass.

## Edge Cases & Tests

- `--mcp-only` + toggle tool: setting persists, no daemon spawned, port 8787 untouched.
- Normal MCP process (non-test): toggle still restarts the daemon as designed.
- `spawnDaemon` from a process whose `HOME` was overridden by tests: daemon still uses real HOME/tokens.
- Daemon spawned in test env serving 8787: refuses loudly or is prevented.
- After `npm test`: no process owns 8787.
- Real proxy healthz: `loggedIn:true`, version matches manifest.
- No tokens or secrets logged.

## Risks & Decisions

- Decision: should the toggle tool in `--mcp-only` still restart the daemon?
  - Recommendation: no — `--mcp-only` is documented as "no side effects on port 8787" and tests rely on it. Persist settings only; the next normal MCP session's daemon picks them up via the existing restart/takeover path when appropriate.
- Decision: force `NODE_ENV` for the daemon?
  - Recommendation: remove test-only overrides instead of hardcoding `production`, keeping daemon behavior deterministic while preserving explicit advanced overrides if ever needed.

## Verification Plan

```bash
node --check server/server.js
npm test
lsof -nP -iTCP:8787 -sTCP:LISTEN   # expect no test process after npm test
curl -s http://127.0.0.1:8787/healthz   # expect loggedIn:true, version 0.2.6
git diff --check
```

Acceptance criteria:

- The leaked test daemon is gone and a clean daemon owns 8787 with `loggedIn:true`.
- Real subagent turns using `gpt-5.6-sol` no longer fail with `reason=unknown retryable=false`.
- Tests never spawn a daemon on the production port.
- All versions are `0.2.6` and all tests pass.

## Execution Notes

- Root cause confirmed live during execution: subagent dispatches failed with `ECONNREFUSED 127.0.0.1:8787` while the leaked test daemon was down, proving ZCode subagent API traffic itself routes through the proxy.
- `gpt_cache_miss_notices` and `restartDaemonForCacheSetting` now no-op on the daemon in `MCP_ONLY` sessions (settings still persist).
- `spawnDaemon()` builds a clean environment: strips `GPT_OAUTH_HOME`/`GPT_OAUTH_PROXY_PORT`, maps `NODE_ENV=test` to `production`, and always passes the real `HOME`, so a daemon owning port 8787 always reads the real token/settings store.
- Added `refuseTestProductionProxy()`: a `NODE_ENV=test` process refuses to bind the default port 8787 without an explicit `GPT_OAUTH_PROXY_PORT` override (loud stderr + exit 1).
- `test/cache-settings.test.js` now snapshots port 8787 listener/health state before and after and asserts the production daemon is untouched; the toggle test asserts `proxyRestarted: false` in `MCP_ONLY` mode.
- Leaked test daemon was shut down via the authorized `/shutdown` endpoint; a clean production daemon was started from the real environment and verified `loggedIn:true`.
- Documentation updated (README + status command) with daemon environment hygiene, `--mcp-only` guarantee, and stale-daemon troubleshooting.
- Versions synchronized to `0.2.6` across `server/server.js`, `.zcode-plugin/plugin.json`, `.zcode-plugin/marketplace.json`, `marketplace.json`, `package.json`.
- Final verification: `git diff --check`, syntax checks, JSON/version consistency, `npm test` 24/24 passed; production daemon on 8787 remained serving throughout (PID stable, healthz `loggedIn:true`).
