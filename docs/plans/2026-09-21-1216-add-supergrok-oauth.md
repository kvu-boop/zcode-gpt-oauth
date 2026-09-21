# Implementation Plan: Add xAI Grok OAuth for SuperGrok subscriptions

## Status
- Status: Completed
- Created: 2026-09-21 12:16
- Approved: Yes — user approved with “go” on 2026-09-21
- Completed: 2026-09-21

## Request Summary
Extend the existing `gpt-oauth` ZCode plugin so a user can authenticate with an xAI account whose Grok or X Premium plan includes Grok API access, using the browser-based **SuperGrok Subscription** OAuth flow implemented by OpenCode. Keep the existing ChatGPT OAuth and GPT proxy behavior fully backward-compatible, require no xAI API key, and expose Grok models through the plugin's existing OpenAI-compatible localhost provider.

Representative acceptance flow:
1. Run `/gpt-oauth:grok-login`.
2. The plugin requests an xAI device code, opens `verification_uri_complete` (or `verification_uri`) in the browser, shows the short `user_code`, and polls while the user approves access.
3. OAuth tokens are stored with mode `0600`; no raw token is printed.
4. Run `/gpt-oauth:setup`; the existing provider now includes GPT and supported Grok text/tool models.
5. A request to `POST http://127.0.0.1:8787/v1/chat/completions` with a `grok-*` model is forwarded to xAI with the OAuth bearer token and works for streaming, non-streaming, and tool calls.

## Repository Findings & Exact References

### Existing plugin
- `.zcode-plugin/plugin.json:1-13` defines plugin `gpt-oauth` v0.2.8, the `commands` directory, and one MCP server backed by `server/server.js`.
- `server/server.js:40-79` currently has one ChatGPT OAuth identity/store, one Codex backend, and token file `~/.zcode/gpt-oauth/auth.json`.
- `server/server.js:207-271` performs atomic token storage and optional read-only import from OpenCode's OpenAI auth entry.
- `server/server.js:526-584` implements deduplicated ChatGPT refresh with rotated refresh-token persistence.
- `server/server.js:650-793` implements ChatGPT PKCE with a loopback callback and cross-platform browser opening.
- `server/server.js:805-960` exposes MCP tools `gpt_login`, `gpt_logout`, `gpt_status`, and cache settings.
- `server/server.js:1036-1135` translates OpenAI chat-completions requests into OpenAI Codex Responses payloads; this translation must remain GPT-only.
- `server/server.js:1287-1822` forwards/streams Codex SSE and translates it back to OpenAI chat-completions format.
- `server/server.js:1828-1946` exposes `/healthz`, `/v1/models`, and `/v1/chat/completions`; routing currently assumes every request uses ChatGPT/Codex.
- `commands/gpt-oauth/login.md`, `setup.md`, and `status.md` document the current ChatGPT-only lifecycle.
- `test/reasoning-effort.test.js:34-122` is the closest integration-test harness for an isolated upstream and localhost proxy.
- `test/cache-settings.test.js:10-78` is the closest MCP subprocess test harness and verifies `--mcp-only` does not disturb the production daemon.

### OpenCode reference reviewed
Reference repository: `anomalyco/opencode`, branch `dev`, file `packages/opencode/src/plugin/xai.ts`, observed at commit `c10134729dd2ce00beb18604ec91f10319f59a78` on 2026-09-21. The feature originated in commit `b32debb8a3327a6cf2b9b9face7f296acc5a1458` and became device-only in `cb88db6ce31dfbf52b2462258b42a607758e200a`.

Exact contract to adapt:
- Public Grok CLI OAuth client ID: `b1a00492-073a-47ea-816f-4c329264a828`.
- Device endpoint: `https://auth.x.ai/oauth2/device/code`.
- Token/refresh endpoint: `https://auth.x.ai/oauth2/token`.
- Grant: `urn:ietf:params:oauth:grant-type:device_code`.
- Scope: `openid profile email offline_access grok-cli:access api:access`.
- Device-code request form includes `client_id`, `scope`, and `referrer=opencode` in OpenCode. This plugin will use `referrer=zcode` unless xAI rejects it; test fixtures must assert the chosen value.
- Polling honors `authorization_pending`, adds at least five seconds for `slow_down`, treats denial/expiry as terminal, normalizes invalid `interval`/`expires_in`, and observes a hard deadline.
- Refresh uses `grant_type=refresh_token`, persists rotated refresh tokens, and refreshes before expiry.
- API requests go to xAI's standard OpenAI-compatible `https://api.x.ai/v1` endpoint with `Authorization: Bearer <access>`.
- OpenCode tests cover request validation, pending/slow-down polling, terminal errors, timeout, malformed timing values, refresh deduplication, refresh-token rotation, and authorization header replacement.
- OpenCode documentation explicitly states that any Grok or X Premium plan that includes Grok API access works and no `XAI_API_KEY` is required.

Current `models.dev` xAI catalog was also inspected. Relevant text/tool-capable model IDs as of 2026-09-21 include `grok-4.3`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-4.5`, `grok-4.6`, and `grok-build-0.1`. Image/video-generation models are outside this plugin's `/v1/chat/completions` contract and will not be registered.

## Proposed Solution & Technical Contracts

### Compatibility and provider contract
Keep the stable plugin identity and localhost provider:

```text
Provider name: gpt-oauth
Kind: openai-compatible
Base URL: http://127.0.0.1:8787/v1
API key placeholder: local-proxy
```

Model-based routing at the local proxy:

```js
function providerForModel(model) {
  if (typeof model === 'string' && model.startsWith('grok-')) return 'xai';
  if (GPT_MODEL_IDS.includes(model)) return 'openai';
  return null; // respond 404; never send an unknown model to the wrong account
}
```

- GPT IDs continue through the unchanged Codex request/response adapter.
- `grok-*` IDs pass through as OpenAI-compatible chat-completions JSON to `${XAI_API_BASE}/chat/completions` with the xAI bearer token.
- The local proxy strips/replaces any client `Authorization` header; credentials never transit from ZCode config.
- The xAI upstream host is fixed by default and test-overridable only through `XAI_OAUTH_API_BASE`.
- Streaming xAI responses are forwarded incrementally with the existing body, header, heartbeat, idle-timeout, error-size, and client-abort protections. No Codex SSE transformation is applied to xAI.
- Non-streaming xAI JSON is forwarded with bounded buffering and upstream status/error mapping.
- On xAI 401, refresh once and retry once; refresh is single-flight so a rotating refresh token is not replayed concurrently.

### xAI token store
Use a separate file to avoid changing or corrupting existing ChatGPT credentials:

```json
// ~/.zcode/gpt-oauth/xai-auth.json, mode 0600
{
  "access": "<secret>",
  "refresh": "<secret>",
  "expires": 0,
  "email": null,
  "scope": "...",
  "savedAt": 0
}
```

Writes remain atomic (`tmp` + rename + chmod), logs/status redact token values, and logout only deletes the selected provider's store.

### MCP tool contracts
Add provider-specific tools without breaking existing tool names:

```text
xai_login() -> { ok, userCode, verificationUri, expires, email? }
xai_logout() -> { ok, wasLoggedIn }
xai_status() -> { loggedIn, expires, accessValid, proxyRunning, lastError }
```

`xai_login` performs device-code authorization and opens the browser. Because the browser cannot signal a localhost callback, the MCP call stays open while polling, up to the xAI `expires_in` deadline. On browser-launch failure, return/show the verification URL and user code without exposing tokens.

The existing `gpt_status` remains backward-compatible. `/healthz` gains nested, non-secret provider state while retaining all existing top-level keys:

```json
{
  "ok": true,
  "version": "<new version>",
  "loggedIn": true,
  "providers": {
    "openai": { "loggedIn": true },
    "xai": { "loggedIn": true }
  },
  "modelCount": 10
}
```

### Model discovery and setup
- `/v1/models` returns the union of static GPT IDs and xAI text/tool models.
- After xAI login, the daemon may query xAI `GET /v1/models` with OAuth and filter to `grok-*`; failure falls back to the versioned text/tool list in this release.
- The setup command registers a conservative static set so ZCode config remains deterministic and usable offline. Recommended initial set: `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-build-0.1`, `grok-4.20-0309-reasoning`, and `grok-4.20-0309-non-reasoning`.
- Setup is idempotent and preserves all existing provider/model/config keys.

## Workstreams

### Workstream 1: xAI OAuth and token lifecycle
- Agent: worker
- Owned Files:
  - `server/xai-oauth.js` (new)
  - `test/xai-oauth.test.js` (new)
- Implementation Steps & Code Blueprint:
  1. Create a zero-dependency module exporting constants and injectable/testable functions:
     ```js
     requestDeviceCode({ deviceAuthorizationUrl, request })
     pollDeviceCodeToken(device, { tokenUrl, request, sleep, now })
     refreshXaiAccess(store, { tokenUrl, request })
     accessTokenIsExpiring(token, skewMs)
     createXaiAuth({ tokenFile, endpoints, openBrowser, logger })
     ```
  2. Implement URL-encoded POSTs with `Accept: application/json`, a ZCode plugin user agent, request timeouts, bounded response bodies, and actionable errors that never include token values.
  3. Implement RFC 8628 polling exactly for `authorization_pending`, `slow_down`, `access_denied`/`authorization_denied`, `expired_token`, malformed timing, deadline, and network failures.
  4. Implement atomic mode-`0600` token persistence, proactive refresh skew, refresh-token rotation, and an in-process single-flight refresh promise.
  5. Decode JWT claims only for expiry/email display; never use unsigned claims for authorization decisions.
  6. Test all adapted OpenCode edge cases plus file mode, atomic rotation, concurrent refresh deduplication, missing `refresh_token` fallback, timeout, and secret redaction.
- Verification: `node --test test/xai-oauth.test.js`

### Workstream 2: Proxy routing, MCP commands, setup, docs, and release metadata
- Agent: worker
- Owned Files:
  - `server/server.js`
  - `test/xai-proxy.test.js` (new)
  - `test/xai-mcp.test.js` (new)
  - `commands/gpt-oauth/grok-login.md` (new)
  - `commands/gpt-oauth/grok-logout.md` (new)
  - `commands/gpt-oauth/setup.md`
  - `commands/gpt-oauth/status.md`
  - `commands/gpt-oauth/login.md`
  - `README.md`
  - `package.json`
  - `.zcode-plugin/plugin.json`
  - `marketplace.json`
  - `.zcode-plugin/marketplace.json`
- Depends On: Workstream 1's exported module contract. Dispatch sequentially because `server/server.js` imports the new module and end-to-end tests require it.
- Implementation Steps & Code Blueprint:
  1. Instantiate xAI auth using `~/.zcode/gpt-oauth/xai-auth.json`; add test-only endpoint/home overrides without leaking them into detached production daemons.
  2. Add MCP `xai_login`, `xai_logout`, and `xai_status`; keep all existing tools and response shapes intact.
  3. Route explicit GPT IDs to Codex and `grok-*` to xAI. Reject unsupported IDs with HTTP 404 before credential lookup.
  4. Implement xAI chat-completions proxying for streaming/non-streaming requests, direct tool calls, image content pass-through, one refresh-and-retry on 401, bounded errors, upstream timeouts, and client abort propagation.
  5. Extend `/healthz` and `/v1/models` without removing existing keys/IDs.
  6. Update `/gpt-oauth:setup` to add Grok text/tool models idempotently while retaining the same provider UUID/base URL. Update login/status documentation and add provider-specific Grok login/logout commands.
  7. Update README quick usage and explicitly state subscription/API-access prerequisites and that Grok media-generation endpoints are not supported.
  8. Bump the same semantic version consistently in code, manifest, package, both marketplace catalogs, and README. The implementing agent should choose the next minor version because this is backward-compatible functionality (expected `0.3.0`).
  9. Build fixture-based integration tests that do not contact xAI or bind production port 8787. Assert bearer replacement, model routing, stream passthrough, non-stream response, tool calls, 401 refresh/retry, `/v1/models`, health state, MCP tool list/calls, and unchanged GPT routing.
- Verification:
  - `node --test test/xai-proxy.test.js test/xai-mcp.test.js`
  - `npm test`
  - Manifest/catalog JSON parse and version-consistency check.

## Integration & Shared Work
- Execute Workstream 1 first, then Workstream 2 against its final exports; no concurrent agents because the second scope imports and validates the first.
- The parent agent will inspect final git status/diff for scope drift and run the repository-wide `npm test` integration gate.
- This is security-critical OAuth/token handling. After implementation and tests pass, the parent agent must perform the required direct review focused on: state/token secrecy, atomic mode-`0600` persistence, refresh rotation/single-flight behavior, device-code deadline/backoff, fixed upstream routing, no production-port side effects in tests, no accidental regression in ChatGPT OAuth, and no credentials in logs/errors.
- Any review fix must be delegated back to the responsible worker and re-tested.
- Update this plan to `Status: Approved` before dispatch and to `Status: Completed` with exact verification results after integration.

## Risks & Open Decisions
- Decision: Rebrand the plugin or preserve `gpt-oauth`?
  - Recommendation: Preserve the stable `gpt-oauth` plugin/provider identity in this change. Renaming would break marketplace/update identity, command names, stored config, and provider UUIDs. Grok gets new commands under the existing namespace. A later separately planned rename can include migration aliases.
- Decision: Device-code OAuth versus localhost callback.
  - Recommendation: Use device-code OAuth exactly as current OpenCode. It is xAI's documented/discovered grant, works in Desktop/VPS/SSH/WSL, and avoids callback port/firewall issues.
- Decision: Dynamic model discovery versus hard-coded setup list.
  - Recommendation: Use a hybrid: authenticated `/v1/models` discovery for runtime visibility, plus a conservative versioned text/tool fallback and deterministic setup list. Do not register image/video-generation models because the proxy only implements chat completions.
- Decision: Use `referrer=opencode` exactly or identify this plugin.
  - Recommendation: Send `referrer=zcode`; the field is attribution, not part of the OAuth grant. If live smoke testing shows xAI validates a fixed allowlist, change only this value to `opencode` and document the compatibility reason.
- Risk: A SuperGrok subscription may not include Grok API access.
  - Mitigation: Status/login wording must say “Grok or X Premium plan that includes Grok API access”; surface xAI's sanitized 401/403 response and do not claim every subscription tier works.
- Risk: xAI rotates refresh tokens and multiple processes can race.
  - Mitigation: Single-flight within the daemon, atomic persistence, and daemon ownership keep normal traffic serialized. A terminal invalid-grant response asks for re-login rather than deleting tokens on a transient first failure.
- Risk: Exact model availability is account-dependent and catalog IDs evolve.
  - Mitigation: Dynamic discovery plus conservative fallback; unknown `grok-*` may be allowed only if discovered, while setup uses the tested static list.
- Risk: Streaming semantics differ from Codex SSE.
  - Mitigation: Treat xAI as OpenAI-compatible and proxy bytes rather than applying the Codex transformer; fixture tests cover SSE framing, `[DONE]`, errors, heartbeat behavior, and aborts.

## Verification Plan
1. `node --test test/xai-oauth.test.js`
2. `node --test test/xai-proxy.test.js test/xai-mcp.test.js`
3. `npm test`
4. Parse `package.json`, `.zcode-plugin/plugin.json`, `marketplace.json`, and `.zcode-plugin/marketplace.json`; assert one matching version and valid paths.
5. Start only an isolated test proxy with `NODE_ENV=test`, temporary `GPT_OAUTH_HOME`, temporary `GPT_OAUTH_PROXY_PORT`, local `GPT_OAUTH_BACKEND_BASE`, local `XAI_OAUTH_API_BASE`, and local xAI OAuth endpoints; verify production port 8787 listener state is unchanged before/after.
6. Verify no test output, daemon log, MCP response, HTTP error, status, or health response contains fixture access/refresh/device tokens.
7. Credential-dependent manual smoke test after code approval and installation/update:
   - `/gpt-oauth:grok-login` opens xAI verification and completes device authorization.
   - `/gpt-oauth:status` reports xAI logged in without secrets.
   - `/gpt-oauth:setup` adds Grok models and survives restart.
   - A short Grok prompt and one tool-call prompt succeed through `http://127.0.0.1:8787/v1`.
   This live test cannot be completed without the user's eligible xAI account and remains explicitly pending if credentials are unavailable.

## Execution Notes
- Added zero-dependency RFC 8628 xAI device OAuth in `server/xai-oauth.js`, including sanitized errors, browser fallback, atomic mode-`0600` token storage, proactive expiry checks, single-flight refresh, and rotated refresh-token persistence.
- Added model-based routing in `server/server.js`: existing GPT models retain the Codex translation path; `grok-*` models use direct xAI OpenAI-compatible chat-completions forwarding; unsupported models return 404 before credential lookup.
- Added xAI non-stream and SSE streaming support with fixed upstream routing, authorization replacement, one refresh retry, header/idle timeouts, real SSE heartbeats, bounded error bodies, client-abort cleanup, and valid post-header SSE error framing.
- Added MCP tools `xai_login`, `xai_logout`, and `xai_status`; extended health and model endpoints without removing existing response fields.
- Added Grok commands, setup metadata, README guidance, plugin/marketplace descriptions, and consistent v0.3.0 release metadata.
- Added `test/xai-oauth.test.js`, `test/xai-mcp.test.js`, and `test/xai-proxy.test.js`. Regression coverage includes pending/slow-down polling, token secrecy and file permissions, refresh concurrency/rotation, explicit provider routing, tool-call passthrough, 401 retry, real SSE newline heartbeat, active-stream idle-timer refresh, post-header SSE failure framing, bounded upstream errors, and production-port isolation.
- Final verification on 2026-09-21: `npm test` passed 58/58; `node --check server/server.js` passed; `node --check server/xai-oauth.js` passed; manifest/catalog JSON and resource checks passed; all release versions equal `0.3.0`; `git diff --check` passed.
- Security review findings were fixed and re-verified: argument-safe Windows browser launch, no daemon test-endpoint inheritance, separate credential stores, safe status/error output, accurate model capabilities, bounded error handling, and single idle timer per stream attempt.
- Pending only: credential-dependent live authorization and real xAI model call with an eligible subscription.
