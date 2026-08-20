---
description: Log in to ChatGPT (GPT Plus) via browser OAuth for gpt-oauth and verify the local proxy.
---

# gpt-oauth: Login

You are logging the user into ChatGPT (GPT Plus) using OAuth for the gpt-oauth plugin.

## Steps

1. Call the MCP tool `gpt-oauth` → `gpt_login`. This opens a browser tab and waits up to 5 minutes for the user to complete login. Do not interrupt; just wait for the tool to return.

2. When `gpt_login` returns, verify the local proxy is up and has the models:
   - Run `curl -s http://127.0.0.1:8787/healthz`
   - Run `curl -s http://127.0.0.1:8787/v1/models`
   Both should return 200. The models call should list `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.

3. Report to the user:
   - The email address that logged in (if provided).
   - The account id.
   - The token expiry time.
   - The proxy health and model count.

4. Remind the user to run `/gpt-oauth:setup` next to add the `gpt-oauth` provider to ZCode's model settings.

Never print raw tokens or secrets in your report — only masked values if ever relevant.
