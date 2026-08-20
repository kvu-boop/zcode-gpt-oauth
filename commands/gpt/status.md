---
description: Show gpt-oauth login status, token expiry, proxy status and last error.
---

# gpt-oauth: Status

Check and report the current status of the gpt-oauth plugin.

## Steps

1. Call the MCP tool `gpt-oauth` → `gpt_status`. Capture its JSON result.

2. Run `curl -s http://127.0.0.1:8787/healthz` to confirm the proxy is reachable.

3. Report to the user:
   - Logged-in state (`loggedIn`).
   - Email and account id (if set).
   - Token expiry time and whether the access token is still valid (`accessValid`).
   - Proxy running status (`proxyRunning`) plus the healthz output.
   - `lastError` if present.

Do not print raw tokens or secrets.
