---
description: Log in to xAI Grok using the browser-based device OAuth flow.
---

# gpt-oauth: Grok Login

Use `/gpt-oauth:grok-login` to authenticate an eligible Grok or X Premium subscription that includes Grok API access. No `XAI_API_KEY` is required.

1. Call the MCP tool `gpt-oauth` → `xai_login`. It requests a device code, opens the xAI verification page, and blocks while polling until approval, denial, expiry, or timeout. On success it returns a safe result with the verification URI, user code, and expiry; it does not return access or refresh tokens. If the browser does not open, use the verification URL and user code shown in the tool's safe guidance.
2. Do not print or request access or refresh tokens.
3. After success, call `xai_status` and verify the local proxy with `curl -s http://127.0.0.1:8787/v1/models`.
4. Run `/gpt-oauth:setup` to register the Grok models in ZCode model settings.

Only text/tool chat completions are supported; image and video generation models are not registered.