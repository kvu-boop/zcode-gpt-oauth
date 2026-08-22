---
description: Disable persistent cache-miss notices for the gpt-oauth proxy.
---

# gpt-oauth: Cache-miss notices off

Disable cache-miss notices persistently. This command is idempotent: running it again keeps the setting disabled.

## Steps

1. Call the MCP tool `gpt-oauth` → `gpt_cache_miss_notices` with exactly `{ "enabled": false }`.
2. If the tool reports an error, report that error and do not claim the setting changed.
3. Verify the daemon has applied the setting by running `curl -s http://127.0.0.1:8787/healthz`. Confirm the response is healthy and `cacheMissNotices` is `false`.
4. Report the persisted/effective state and the health-check result. Never print tokens or secrets.

Disabling this setting stops the proxy cache analytics/notices extension. It does not change OAuth tokens, provider configuration, or request metadata.
