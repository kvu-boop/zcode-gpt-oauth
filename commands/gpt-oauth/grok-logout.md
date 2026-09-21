---
description: Log out of the xAI Grok OAuth account without changing ChatGPT login.
---

# gpt-oauth: Grok Logout

Call the MCP tool `gpt-oauth` → `xai_logout` to remove the stored xAI OAuth credentials. This only logs out Grok; it does not delete the ChatGPT credentials used by `/gpt-oauth:login`.

Then call `xai_status` to verify `loggedIn: false`. Never print raw tokens or secrets.