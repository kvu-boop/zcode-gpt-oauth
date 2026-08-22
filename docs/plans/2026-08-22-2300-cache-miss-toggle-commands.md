# Implementation Plan: Persistent Cache Miss Toggle Commands (v0.2.5)

## Status
- Status: Completed
- Created: 2026-08-22 23:00
- Approved: Yes (2026-08-22)
- Completed: 2026-08-22

## Request Summary

Provide user-facing commands to enable and disable cache-miss notices without requiring GUI-process environment variables. Persist the setting, apply it to the detached daemon automatically, and expose the active state through status and health responses.

## Repository Findings & Exact References

- `server/server.js:63` currently reads `GPT_OAUTH_CACHE_MISS_NOTICES` once into a process constant. This makes GUI-launched ZCode difficult to configure.
- `server/server.js:75-77` already centralizes plugin state under `~/.zcode/gpt-oauth/`, currently for OAuth tokens.
- `server/server.js:159-178` provides the existing atomic token-store pattern that can be mirrored for a non-secret settings file.
- `server/server.js:711-776` handles MCP tools; `gpt_status` is the natural place to report the persisted/effective setting.
- `server/server.js:805-825` publishes the MCP tool schemas.
- `server/server.js:1521+` owns `/healthz`; it can expose the daemon's effective `cacheMissNotices` value.
- `commands/gpt-oauth/*.md` are user-invocable slash-command workflows. Existing commands call MCP tools rather than modifying runtime files directly.
- Version sources are `server/server.js`, `.zcode-plugin/plugin.json`, `.zcode-plugin/marketplace.json`, `marketplace.json`, and `package.json`, all currently `0.2.4`.

## Proposed Solution & Technical Contracts

### Persistent settings

Create a non-secret file:

```text
~/.zcode/gpt-oauth/settings.json
```

Schema:

```json
{
  "cacheMissNotices": true
}
```

Rules:

- Missing/malformed file defaults to `false`.
- Save atomically with mode `0600`, using the existing temp-file + rename pattern.
- Preserve future unknown settings keys on updates.
- `GPT_OAUTH_CACHE_MISS_NOTICES` remains an explicit startup override for tests/advanced users; otherwise the daemon reads the persisted setting.
- Effective precedence:

  ```text
  explicit environment variable > persisted settings > false
  ```

### MCP tool

Add:

```text
gpt_cache_miss_notices
```

Input:

```json
{
  "enabled": true
}
```

Output:

```json
{
  "ok": true,
  "cacheMissNotices": true,
  "proxyRestarted": true
}
```

Behavior:

1. Validate `enabled` is boolean.
2. Persist the setting.
3. If the daemon is running with a different effective value, use the existing authorized `/shutdown` + `ensureDaemon()` lifecycle to restart it from current code.
4. Poll `/healthz` and return only after it reports the requested state.
5. Do not touch OAuth tokens or print secrets.
6. If an explicit environment override conflicts with the requested setting, return a clear error rather than claiming success.

Extend `gpt_status` with:

```json
{
  "cacheMissNotices": true
}
```

Extend `/healthz` with the daemon-effective value:

```json
{
  "cacheMissNotices": true
}
```

### Slash commands

Create two explicit, idempotent commands:

- `/gpt-oauth:cache-miss-on`
- `/gpt-oauth:cache-miss-off`

Each calls `gpt_cache_miss_notices` with a fixed boolean, verifies `/healthz`, and reports the resulting state. Explicit on/off commands are safer than a blind toggle because rerunning the same command cannot accidentally reverse the user's intended state.

Update `/gpt-oauth:status` to report the setting.

### Runtime behavior

Replace direct checks of the old constant with a process-effective value loaded at startup. The daemon does not need per-request disk reads. MCP configuration changes restart the daemon through the existing safe takeover lifecycle.

This command only enables the analytics/response extension. Cache detection still requires comparable request metadata (`cache_control.session_id` and `lineage_id`) and provider cache telemetry; the command documentation must state this limitation honestly.

## Workstreams

### Workstream 1: Persistent setting, MCP tool, daemon lifecycle, tests

- Agent: `worker`
- Owned files:
  - `server/server.js`
  - `test/cache-settings.test.js`
  - `test/cache-integration.test.js`
- Implementation steps:
  1. Add settings load/save/effective-value helpers.
  2. Add `gpt_cache_miss_notices` handler and MCP schema.
  3. Restart/poll daemon after a setting change.
  4. Add setting to `gpt_status` and `/healthz`.
  5. Test defaults, persistence, malformed settings, environment precedence/conflict, on/off transitions, daemon restart, and effective health state.
- Verification:
  - `node --check server/server.js`
  - `node --test test/cache-settings.test.js test/cache-integration.test.js`
  - `npm test`

### Workstream 2: Commands, documentation, and versioning

- Agent: `worker`
- Owned files:
  - `commands/gpt-oauth/cache-miss-on.md`
  - `commands/gpt-oauth/cache-miss-off.md`
  - `commands/gpt-oauth/status.md`
  - `README.md`
  - `.zcode-plugin/plugin.json`
  - `.zcode-plugin/marketplace.json`
  - `marketplace.json`
  - `package.json`
- Implementation steps:
  1. Add explicit on/off slash-command workflows.
  2. Update status workflow and README usage/limitations.
  3. Synchronize all version metadata to `0.2.5` after tests pass.
- Verification:
  - Parse all JSON metadata.
  - Verify all version fields equal `0.2.5`.
  - `npm test`

The workstreams have disjoint file ownership and can run concurrently after approval. The MCP tool name/input/output above is the shared contract.

## Edge Cases & Tests

- No settings file: disabled.
- Malformed/non-object settings file: disabled, no crash.
- Unknown keys survive update.
- Repeated enable or disable is idempotent.
- Daemon already stopped: save then start with requested state.
- Daemon running old/equal version: authorized restart and health polling.
- Restart failure: persisted value remains truthful, command reports failure and daemon diagnostics.
- Explicit environment override agrees with setting: success.
- Explicit environment override conflicts: clear error; do not claim runtime changed.
- Concurrent setting writes remain atomic.
- OAuth store is unchanged.
- `/healthz`, `gpt_status`, and MCP command result agree.
- Existing completions remain unchanged while disabled.
- All existing 20 tests continue to pass.

## Risks & Decisions

- Decision: one blind toggle versus explicit on/off commands.
  - Recommendation: two idempotent commands to avoid accidental reversal and support automation.
- Decision: dynamic per-request settings read versus daemon restart.
  - Recommendation: persist once and restart through the existing lifecycle; avoid filesystem I/O on every completion.
- Decision: environment variable compatibility.
  - Recommendation: retain it as explicit override for tests/advanced operation, but detect conflicts clearly.
- Limitation: enabling the setting does not make ZCode inject session/lineage metadata or render notice UI. It enables proxy analytics and `cache_usage`/`cache_notice` output for clients that satisfy the existing contract.

## Verification Plan

```bash
node --check server/server.js
for f in test/*.js; do node --check "$f"; done
npm test
git diff --check
```

Acceptance criteria:

- `/gpt-oauth:cache-miss-on` persists and activates the feature without manual environment setup.
- `/gpt-oauth:cache-miss-off` persists and deactivates it.
- Daemon restart is automatic and verified through `/healthz`.
- Status reports the effective setting.
- Repeated commands are idempotent.
- No token files or secrets are exposed or altered.
- All versions are `0.2.5` and all tests pass.

## Execution Notes

- Implemented persistent `settings.json` under the plugin state directory, atomic `0600` writes preserving unknown keys, default `false`.
- Effective-setting precedence: explicit `GPT_OAUTH_CACHE_MISS_NOTICES` env override > persisted setting > `false`; conflicting env override rejects the toggle request with a clear error instead of claiming success.
- Added MCP tool `gpt_cache_miss_notices` (boolean input) that persists the setting, restarts the daemon through the existing authorized `/shutdown` + `ensureDaemon` lifecycle when the effective value changed, and polls `/healthz` to verify the requested state.
- Added `cacheMissNotices` to `gpt_status` and `/healthz`.
- Added idempotent slash commands `/gpt-oauth:cache-miss-on` and `/gpt-oauth:cache-miss-off`, updated status command and README with usage, persistence behavior, env override note, and honest telemetry/UI limitations.
- OAuth token store (`auth.json`) is untouched by the settings feature and covered by a dedicated test.
- Synchronized `VERSION`, plugin manifest, marketplace manifests, and package metadata to `0.2.5`.
- Final verification: `git diff --check`, syntax checks for server and tests, JSON/version consistency, and `npm test` all passed. Test result: 24 passed, 0 failed.
