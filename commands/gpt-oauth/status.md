---
description: Show gpt-oauth login status, token expiry, proxy status, cache-miss setting, and last error.
---

# gpt-oauth: Status

Check and report the current status of the gpt-oauth plugin.

## Steps

1. Call the MCP tool `gpt-oauth` → `gpt_status`. Capture its JSON result.
2. Run `curl -s http://127.0.0.1:8787/healthz` to confirm the proxy is reachable and capture its JSON result.
3. Report to the user:
   - Logged-in state (`loggedIn`).
   - Email and account id (if set).
   - Token expiry time and whether the access token is still valid (`accessValid`).
   - Proxy running status (`proxyRunning`) plus the healthz output.
   - Effective/persisted `cacheMissNotices` state from status and healthz.
   - `lastError` if present.
4. If the setting needs changing, direct the user to `/gpt-oauth:cache-miss-on` or `/gpt-oauth:cache-miss-off`. These commands persist the choice and verify healthz; no manual environment setup is needed.

Do not print raw tokens or secrets.
