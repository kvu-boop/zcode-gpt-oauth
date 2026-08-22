---
description: Enable persistent cache-miss notices for the gpt-oauth proxy.
---

# gpt-oauth: Cache-miss notices on

Enable cache-miss notices persistently. This command is idempotent: running it again keeps the setting enabled.

## Steps

1. Call the MCP tool `gpt-oauth` → `gpt_cache_miss_notices` with exactly `{ "enabled": true }`.
2. If the tool reports an error (including an environment override conflict), report that error and do not claim the setting changed.
3. Verify the daemon has applied the setting by running `curl -s http://127.0.0.1:8787/healthz`. Confirm the response is healthy and `cacheMissNotices` is `true`.
4. Report the persisted/effective state and the health-check result. Never print tokens or secrets.

This enables proxy cache analytics and `cache_usage`/`cache_notice` extensions, but does not inject `cache_control.session_id` or `lineage_id`, provide provider cache telemetry, or render notice UI. Cache-miss detection therefore only works when the request and provider supply the comparable metadata/telemetry required by the proxy.
