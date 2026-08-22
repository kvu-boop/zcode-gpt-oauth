---
description: Show gpt-oauth login status, token expiry, proxy status, cache-miss setting, and last error.
---

# gpt-oauth: Status

Check and report the current status of the gpt-oauth plugin.

## Steps

1. Call the MCP tool `gpt-oauth` → `gpt_status`. Capture its JSON result.
2. Run `curl -s http://127.0.0.1:8787/healthz`, capture its JSON result, and check its `loggedIn` state. The HTTP daemon always uses the real user's `HOME` for token discovery and must never inherit test environment overrides. Processes run with `--mcp-only` never spawn or touch the proxy daemon on port `8787`.
3. Report to the user:
   - Logged-in state (`loggedIn`).
   - Email and account id (if set).
   - Token expiry time and whether the access token is still valid (`accessValid`).
   - Proxy running status (`proxyRunning`) plus the healthz output.
   - Effective/persisted `cacheMissNotices` state from status and healthz.
   - `lastError` if present.
4. If the setting needs changing, direct the user to `/gpt-oauth:cache-miss-on` or `/gpt-oauth:cache-miss-off`. These commands persist the choice and verify healthz; no manual environment setup is needed.
5. If `/healthz` shows `loggedIn:false` while `~/.zcode/gpt-oauth/auth.json` is valid, explain that a stale test daemon may own port `8787`; recommend `POST /shutdown` with header `x-gpt-oauth-shutdown: 1`, then restart via the plugin lifecycle (`/gpt-oauth:status` or restarting ZCode).

Do not print raw tokens or secrets.
