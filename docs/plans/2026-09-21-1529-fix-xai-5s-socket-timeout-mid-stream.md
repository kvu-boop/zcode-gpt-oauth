# Implementation Plan: Fix Grok "Turn execution failed" mid-stream (xAI 5s socket timeout)

## Status
- Status: Completed
- Created: 2026-09-21 15:29
- Approved: Yes (2026-09-21)
- Completed: 2026-09-21

## Request Summary

A ZCode turn using `grok-4.6` through the `gpt-oauth` proxy died part-way through the
response:

```text
Turn execution failed
provider=52fb78c2-e540-453b-b790-5d26a4e66f55 model=grok-4.6 request=8227b361-376f-4c1f-9186-43c0d4e6beb9 reason=unknown retryable=false
```

Diagnose the root cause and fix it so Grok streaming survives normal upstream pauses.

## Root Cause (Verified by reproduction)

The proxy aborts **any xAI request after 5 seconds of upstream silence**, and it does so
*after* it has already sent SSE headers, so it injects an error frame into the middle of a
healthy stream.

Evidence chain:

1. ZCode's own log (`~/.zcode/cli/log/zcode-2026-09-21.jsonl`, lines 9744-9749) carries the
   real cause that its UI hides behind `reason=unknown`:

   ```json
   "cause": {"name":"UnknownError","message":"xAI upstream timeout"}
   ```

2. The recorded stream metadata (`~/.zcode/cli/rollout/model-io-sess_783a2782-....jsonl`,
   line 4) shows the proxy's own SSE headers plus an upstream `responseId`, i.e. headers had
   been sent and real content had flowed before the failure. ZCode aborted with
   `TerminalStreamChunkError` from `handleStreamErrorEvent` — its parser saw an `error`
   object inside the SSE stream, which is exactly the frame `finish()` writes when
   `clientHeadersSent` is already true (`server/server.js:1667-1674`).

3. Controlled reproduction (`--http-only` proxy pointed at a mock xAI API that stalls after
   three chunks):

   ```text
   [client] +7ms     data: {"id":"resp-1",...}
   [client] +5009ms  data: {"error":{"message":"xAI upstream timeout",...}}
   [client] +5009ms  data: [DONE]
   ```

   The same mock with a **non-streaming** request returns
   `+5011ms status=504 {"error":{"message":"xAI upstream timeout"}}`.

4. The 5 seconds is a **Node.js default, not repo configuration**: Node 24's default keep-alive
   agent applies a 5000 ms socket inactivity timeout.

   ```text
   node v24.20.0
   socket.timeout = 5000 (ms)
   agent = Agent {"keepAlive":true}
   >>> TIMEOUT event fired at 5011 ms
   ```

   This is normally harmless because Node's socket `'timeout'` is only a *notification* — the
   request is not aborted. The xAI code is the only place that turns the notification into a
   fatal error:

   | function | explicit `timeout` option | `on('timeout')` handler | result under 5s silence |
   | --- | --- | --- | --- |
   | `getJSON` (309) | yes (20s) | destroy | intended |
   | `requestJSON` (331) | yes (3s) | destroy | intended |
   | `postForm` (362) | yes (30s) | destroy | intended |
   | `postBackend` (1355) | yes (120s) | fail | intended |
   | `upstreamStream` (GPT stream) | no | **none** | ignored, **survives** |
   | `xaiRequest` (1533) | no | **yes → 504** | **BUG** |
   | `xaiStream` (1633) | no | **yes → 504** | **BUG** |

   The two xAI functions copied the handler pattern from functions that *do* pass an explicit
   `timeout`. Because they pass none, the only thing that can fire the event is Node's implicit
   5 s default — an accident, not a design.

5. Counter-reproduction on the GPT path, identical 30 s stall: it survives (`: keep-alive`
   heartbeats, then `finish_reason: stop` and `data: [DONE]`). This confirms the differentiator
   is the handler, not the stall, and that removing it makes xAI match behaviour already proven
   in production for GPT models.

### Why this hit hard reasoning models

The timer is measured from the *last byte*, not from request start. The two real failures took
12.2 s and 13.8 s because data flowed periodically and reset the timer; the kill came at the
first gap longer than 5 s. Thinking models (`grok-4.6`) routinely pause longer than that —
between reasoning phases, before the first token, or during tool planning. The four failures at
08:18:16 (~5.0-5.2 s each, surfaced by ZCode as "Provider returned a server error") are the same
defect on the pre-headers path, where the proxy answers `504` instead of injecting a frame.

### Why it was invisible

The xAI code paths emit **no log lines at all**, so `~/.zcode/gpt-oauth/daemon.log` contains zero
`grok`/`xai` entries even under heavy Grok use. The GPT path logs start/headers/done/ERROR
(`server/server.js:2130-2132`, `2272`, `2280`), so this class of incident is diagnosable there
but blind for xAI. (The xAI support landed in v0.3.0, after the v0.2.7 logging workstream.)

### Why the test suite missed it

Every existing xAI test keeps its stall far below 5 s and drives the *internal* idle timer down
with `GPT_OAUTH_STREAM_IDLE_TIMEOUT_MS` (e.g. `test/xai-proxy.test.js:147` uses `40 ms`, line 168
uses `35 ms`, line 192 uses `40 ms`). The internal timer therefore always wins the race, and the
Node default never gets a chance to fire.

## Proposed Solution

### Code fixes (`server/server.js`)

1. **Remove the two fatal `'timeout'` handlers** — the actual bug.

   `xaiRequest`, lines 1623-1627 — delete:

   ```js
   req.once('timeout', () => {
     const error = timeoutError('xAI upstream timeout', 504);
     finishError(error);
     req.destroy(error);
   });
   ```

   `xaiStream`, line 1754 — delete:

   ```js
   request.once('timeout', () => fail(Object.assign(new Error('xAI upstream timeout'), { upstreamStatus: 504 })));
   ```

   Two real bounds already exist and are unaffected: `headersTimer`
   (`xAI upstream headers timeout`, `STREAM_HEADERS_TIMEOUT_MS` = 45 s, lines 1617-1621 and
   1752-1753) and `idleTimer` (`xAI upstream idle timeout`, `STREAM_IDLE_TIMEOUT_MS` = 45 s,
   lines 1688-1690). A genuinely dead upstream still fails within 45 s; a merely quiet one no
   longer dies at 5 s. The unreachable `timeoutError` helper in `xaiRequest` should be dropped
   with it if it becomes unused (check `upstreamStatus` usages first).

2. **Make the socket timeout explicit** (defence in depth, guards against the Node default
   ever changing). Pass an explicit timeout in both xAI request option objects — `xaiRequest`
   line 1568 and `xaiStream` line 1685 — rather than inheriting Node's implicit 5 s.

   *Recommendation:* leave the socket timeout disabled (`timeout: 0`) so the module's own two
   timers remain the single source of truth, with a short comment saying long reasoning pauses
   are normal and why the socket notification must not be treated as fatal.
   *Implementer requirement:* verify empirically that the value actually lands on the socket
   (a test that logs `socket.timeout`, or the regression test below); if Node's agent applies its
   own value afterwards, fall back to the env-sourced variant and document it. Do not ship this
   sub-change on an assumption — the validated part of this plan is item 1.

3. **Add xAI-path logging** so future incidents are visible in `daemon.log`. Mirror the GPT path's
   vocabulary on both xAI paths: `start`, `upstream headers <status> (<ms>)`, `done <ms>` with
   first-event and event/chunk counts, and `ERROR status=<n> <ms>: <message>`. Add the same for
   non-streaming Grok. Never log tokens, `Authorization` headers, or prompt content.

### Tests (`test/xai-proxy.test.js`)

4. **Regression test for the real defect**: mock upstream sends headers plus one chunk, then
   stays silent for **6000 ms** (deliberately above Node's 5 s default; the internal idle timer
   must stay at its default 45 s or be set above the stall so it cannot win the race). Assert the
   stream completes with `data: [DONE]`, contains no `data: {"error"` frame, and that the proxy
   did not emit `xAI upstream timeout`.

5. **Non-streaming counterpart**: same stall on a `stream: false` Grok request; assert `200` and a
   valid body rather than `504 xAI upstream timeout`.

6. **Keep the intentional-timeout coverage honest**: the existing header-timeout test
   (`test/xai-proxy.test.js:199-202`, `504` on a silent upstream) must still pass — it exercises
   `headersTimer`, which is the correct mechanism and must not be weakened by this fix.

   Note: item 4 adds roughly 6 s to the suite. If item 2 is implemented with an env-sourced socket
   timeout, the same regression can be driven in milliseconds — prefer that if the implementer can
   prove the option takes effect.

### Version and delivery

7. Bump to **0.3.2** across `server/server.js` (`VERSION`), `package.json`,
   `.zcode-plugin/plugin.json`, `.zcode-plugin/marketplace.json`, `marketplace.json` — the same
   set v0.3.1 touched.
8. Deployment matters here: the running daemon executes from the **plugin cache**
   (`~/.zcode/cli/plugins/cache/zcode-gpt-oauth/gpt-oauth/<version>/server/server.js`), not from
   this repo — currently a byte-identical copy of `0.3.1`. The fix only takes effect after the
   plugin is updated/reinstalled and the daemon restarted (`POST /shutdown` with
   `x-gpt-oauth-shutdown: 1`, then re-spawned). Treat this as part of Definition of Done, and
   re-verify with the healthz version string.

## Workstreams

### Workstream 1: Fix and regression tests

- Agent: `worker`
- Owned files: `server/server.js`, `test/xai-proxy.test.js`
- Steps: items 1-6 above.
- Verification:
  - `node --check server/server.js`
  - `node --test test/xai-proxy.test.js`
  - `npm test`
  - New regression test must **fail** against the unfixed code (confirm it reproduces the 5 s
    abort), then pass after the fix — this is the acceptance proof, not the green suite alone.

### Workstream 2: Version, deploy, live verification

- Agent: `worker`
- Owned files: version metadata, `README.md` (only if a troubleshooting note is warranted)
- Steps: item 7, then item 8 (install updated plugin, restart daemon).
- Verification:
  - `curl -s http://127.0.0.1:8787/healthz` reports `version: 0.3.2` and
    `providers.xai.loggedIn: true`.
  - One real streaming `grok-4.6` request through the proxy completes with `data: [DONE]`.
  - `grok` entries now appear in `~/.zcode/gpt-oauth/daemon.log`.
  - A real ZCode turn on `grok-4.6` completes without `Turn execution failed`.

## Edge Cases & Tests

- Upstream silent 6 s mid-stream (after content): stream must complete, not abort.
- Upstream silent 6 s before first byte: must still complete (or fail only at the 45 s header
  bound, never at 5 s).
- Upstream silent 6 s on a non-streaming request: must return 200.
- Upstream truly dead (>45 s): headers timer and idle timer must still terminate with `504`/`502`.
- Client disconnects mid-stream: `onClientAbort` still cancels cleanly.
- 401 refresh-and-retry path on the xAI stream is untouched and still retries once.
- No secrets (tokens, `Authorization`, prompt content) in the new log lines.

## Risks & Decisions

- **Decision: remove the handler vs. configure the timeout.** Recommendation: remove the handler
  (item 1) — it is the empirically validated fix and matches the GPT path proven in production.
  Making the socket timeout explicit (item 2) is additive hardening only, and must be empirically
  confirmed before shipping.
- **Decision: is the 45 s idle bound still right for thinking models?** Recommendation: keep 45 s.
  It is already env-tunable (`GPT_OAUTH_STREAM_IDLE_TIMEOUT_MS`) and is not implicated here; the
  bug was the 5 s abort, not the 45 s bound. Revisit only if a real Grok turn still trips 45 s.
- **Risk: a slow regression test.** 6 s is a real cost in `npm test`. Accepted for one test unless
  item 2 makes a fast variant provable.
- **Risk: stale daemon serves the old code** and the bug appears unfixed. Mitigated by the
  healthz version check in Workstream 2.
- **Risk: the daemon is shared** — restarting it drops in-flight streams from other sessions.
  Acceptable; the current daemon is running known-broken code for Grok.

## Verification Plan

```bash
node --check server/server.js
node --test test/xai-proxy.test.js
npm test
git diff --check
curl -s http://127.0.0.1:8787/healthz          # expect version 0.3.2, providers.xai.loggedIn true
```

Acceptance criteria:

- A `grok-4.6` stream whose upstream pauses longer than 5 s completes normally with `data: [DONE]`
  and no injected error frame.
- Non-streaming Grok no longer returns `504 xAI upstream timeout` on a quiet upstream.
- Real and internal 45 s bounds still terminate genuinely dead upstreams.
- ZCode turns on `grok-4.6` no longer fail with `reason=unknown retryable=false`.
- Grok traffic is visible in `daemon.log`.
- All tests pass; versions consistent at 0.3.2.

## Execution Notes

### Fix (Workstream 1)

- Deleted the fatal `req.once('timeout', ...)` handler in `xaiRequest` and the
  `request.once('timeout', ...)` handler in `xaiStream`. `timeoutError`, `headersTimer` (45 s)
  and `idleTimer` (45 s) are intact.
- Item 2 (explicit socket timeout) was kept **with empirical proof**: a standalone probe showed
  `socket.timeout` defaults to `5000`, becomes `0` for `timeout: 0`, and tracks any other value;
  with `timeout: 0` zero `'timeout'` events fired across a 6 s stall while the default fired one.
  Proven inside the real module too, via temporary in-situ instrumentation against a stalling mock
  (`PROBE xaiStream socket.timeout=0`, control `=12345`); instrumentation removed afterwards.
  Shipped as `XAI_SOCKET_TIMEOUT_MS = 0` on both xAI request option objects, with a comment
  recording that the socket notification is non-fatal and the 45 s timers are the real bounds.
- An isolation run with the explicit option temporarily removed (Node's 5000 ms default back in
  force, handlers gone) also passed — confirming the handler removal alone is sufficient and the
  fix does not depend on Node's option handling.
- Added xAI logging to both paths: `start`, `upstream headers <status> (<ms>)`,
  `done <ms> chunks= bytes=`, `ERROR status=<n> <ms> chunks= bytes=: <msg>`, and
  `upstream 401 -> refresh & retry`. Helpers `oneLine()` (single-line, 300-char cap) and
  `xaiErrorStatus()`. No tokens, `Authorization` headers, or prompt content are logged.

### Fail-then-pass evidence (required by this plan)

- Pre-fix, `node --test --test-name-pattern="5s Node socket default" test/xai-proxy.test.js`:
  both new tests failed — streaming asserted against
  `data: {"error":{"message":"xAI upstream timeout",...}}` injected at 5010 ms; non-streaming got
  `504 !== 200`.
- Post-fix, same command: 2/2 pass.

### Tests (integration gate, run by parent)

- `npm test` → **70 tests, 70 pass, 0 fail** (12.9 s).
- The two new regression tests are 6 s each by necessity (they must exceed Node's 5 s default),
  so the suite grew by ~12 s rather than the ~6 s estimated in the plan.

### Version and delivery (Workstream 2)

- Bumped to `0.3.2` across `server/server.js` (`VERSION`), `server/xai-oauth.js`
  (`XAI_USER_AGENT`), `package.json`, `.zcode-plugin/plugin.json`,
  `.zcode-plugin/marketplace.json`, `marketplace.json`, and the README version line.
  Left intentionally unchanged: the illustrative install path in `commands/gpt-oauth/setup.md`
  and historical `docs/plans/` records.
- **Deployment was done via the plugin's own daemon takeover, not the app UI** (no ZCode CLI is
  available to script a plugin update): running `server/server.js` from the repo triggered
  `ensureDaemon` → `/shutdown` of the 0.3.1 daemon → spawn of a detached 0.3.2 daemon from the
  repo path. Log: `Daemon version 0.3.1 is older than v0.3.2; takeover via /shutdown handshake`
  → `Spawned detached daemon (pid 55078)` → `Daemon healthy after spawn (v0.3.2)`.
- **Plugin cache was patched as a durability stopgap.** The running daemon executes from the
  plugin cache, not the repo, so a future respawn from the still-labelled `0.3.1` cache install
  would reintroduce the bug. `server/server.js` and `server/xai-oauth.js` were copied into
  `cache/zcode-gpt-oauth/gpt-oauth/0.3.1/server/` (both now byte-identical to the repo). The
  app-managed registry JSON was deliberately **not** hand-edited. The patched copy was booted on
  an isolated port and reported `version: 0.3.2` with both providers logged in.
- **Still open (user action):** the canonical plugin update to `0.3.2` in the ZCode app has not
  been performed, so `installed_plugins.json` still records `0.3.1`. Until it is done, ZCode will
  show an update as available; the code is already correct in the cache.

### Live verification

- `curl -s http://127.0.0.1:8787/healthz` → `version: 0.3.2`, `providers.xai.loggedIn: true`,
  `modelCount: 10`.
- Real streaming `grok-4.6` request through the proxy: 28 SSE lines, `data: [DONE]` present,
  **zero** error frames, `reasoning_content` deltas received.
- `~/.zcode/gpt-oauth/daemon.log` now records Grok traffic (previously zero xAI entries):
  `xai stream model=grok-4.6 start` → `upstream headers 200 (505ms)` →
  `done 4495ms chunks=7 bytes=3215`.

### Follow-ups

- Commit the working tree (8 files + this plan) — not done, pending an explicit request.
- Run the plugin update in the ZCode app to reconcile the install at `0.3.2`.
- The streaming path's client-abort branch (`onClientAbort`) still does not emit a log line, so a
  client-side disconnect mid-stream remains invisible in `daemon.log`. Consider logging it if
  future incidents point that way.

