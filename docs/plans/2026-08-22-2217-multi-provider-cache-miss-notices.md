# Implementation Plan: Multi-provider Cache Miss Notices

## Status
- Status: Completed
- Created: 2026-08-22 22:17
- Approved: Yes (2026-08-22)
- Completed: 2026-08-22

## Request Summary

Add an opt-in `cacheMissNotices` capability inspired by Pi Agent, without a Pi runtime dependency and without embedding provider-specific assumptions in shared logic. The feature must normalize cache usage, compare comparable requests in a session, report significant re-billed tokens and idle time, and estimate only the incremental cache-miss cost when trustworthy pricing exists.

This document is research and implementation planning only. No runtime implementation has started.

## Research Basis

### Repository findings and exact references

The repository is currently a single-provider, zero-dependency Node.js proxy, not a multi-provider application:

- `server/server.js:5-8` describes one GPT OAuth MCP server and one local OpenAI-compatible proxy.
- `server/server.js:52-56` fixes the upstream to the ChatGPT Codex backend, with `GPT_OAUTH_BACKEND_BASE` as a test override.
- `server/server.js:73-74` advertises only `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` owned by `chatgpt-oauth`.
- `server/server.js:842-940` (`buildBackendBody`) converts Chat Completions requests into the Codex Responses request shape.
- `server/server.js:1026-1083` (`postBackend`) and `server/server.js:1095-1193` (`upstreamStream`) implement the non-streaming and streaming upstream calls.
- `server/server.js:1196-1222` (`doChatCompletion`) parses the complete upstream SSE response for non-streaming clients.
- `server/server.js:1224-1272` (`transformEvents`) extracts only `input_tokens` and `output_tokens` from `response.completed.response.usage`.
- `server/server.js:1275-1291` (`nonStreamReply`) serializes a standard Chat Completions response.
- `server/server.js:1304-1516` (`handleStream`) converts upstream Responses SSE incrementally. Cache metadata is currently dropped with other unhandled event data.
- `server/server.js:1383-1396` emits terminal streaming usage; `server/server.js:1463-1466` captures the raw upstream usage.
- `server/server.js:1521-1694` owns the loopback HTTP routes and request boundary.
- `README.md:22-27` and `commands/gpt-oauth/setup.md:17-47` show that provider registration happens in ZCode configuration outside this runtime.
- No provider abstraction, session object, UI API, package manifest, or test suite currently exists.

Architectural consequence: the reusable cache analytics can be made provider-neutral in this repo, but the only runtime adapter that can be wired now is the GPT OAuth/Codex Responses adapter. DeepSeek direct and OpenCode Go adapters must remain isolated adapters/fixtures until this plugin actually gains routes for those providers or the shared modules are moved into a broader host package.

### Pi Agent reference implementation

Research was pinned to `earendil-works/pi` commit `c49906ec77788625aacbdc53ebca6fbe65bd20f5` (2026-08-21), with the feature introduced by PR #6427 / merge commit `3f9aa5d10b35223abf6146f960ff5cb5c68053ee`.

Verified source behavior:

- Pi normalizes usage to `input`, `output`, `cacheRead`, `cacheWrite`, optional `cacheWrite1h`, and per-category costs in `packages/ai/src/types.ts`.
- OpenAI Responses normalization reads `input_tokens_details.cached_tokens` and `cache_write_tokens`, then derives ordinary input as `max(0, input_tokens - cached - cacheWrite)`.
- Pi reconstructs full prompt volume as `input + cacheRead + cacheWrite`.
- Its comparison formula is:

  ```text
  previousPrompt = previous.input + previous.cacheRead + previous.cacheWrite
  currentPrompt  = current.input  + current.cacheRead  + current.cacheWrite
  missedTokens   = min(previousPrompt, currentPrompt) - current.cacheRead
  ```

- `missedTokens <= 1,024` is treated as cache-breakpoint granularity noise.
- A transcript notice is significant when `missedTokens >= 20,000 OR missedCost >= $0.10`.
- Cost is incremental waste, not total request cost. Pi compares the current paid-input rate with the cache-read rate and clamps the result to zero.
- Idle duration is the non-negative difference between consecutive assistant-message timestamps. Pi labels idle only after a provider TTL reference (five minutes in its Anthropic-oriented implementation), while model switch takes display precedence.
- Compaction and branch-summary boundaries reset comparison state. First requests, zero prompts, errors, and unsupported-cache segments do not create misses.
- `showCacheMissNotices` defaults to false.
- Pi reconstructs notices from usage history rather than persisting notice strings.

Pi sources:

- https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/coding-agent/src/core/cache-stats.ts
- https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/coding-agent/test/cache-stats.test.ts
- https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/api/openai-responses-shared.ts
- https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/models.ts
- https://github.com/earendil-works/pi/pull/6427

This plan adopts Pi's overlap comparison and two-level thresholds, but improves support tracking by keying it to provider, model, session, and comparable-context lineage instead of using one sticky cache-support flag across provider switches.

### Official provider metadata and pricing research

Sources below were accessed 2026-08-22.

#### OpenAI Platform API

Official prompt caching documentation exposes:

```text
Responses API:
usage.input_tokens
usage.output_tokens
usage.input_tokens_details.cached_tokens
usage.input_tokens_details.cache_write_tokens   # documented for GPT-5.6+

Chat Completions API:
usage.prompt_tokens
usage.completion_tokens
usage.prompt_tokens_details.cached_tokens
usage.prompt_tokens_details.cache_write_tokens
```

There is no direct OpenAI `cache_miss_tokens` field. Ordinary non-hit input can be derived from totals, but for models without write telemetry it cannot always be separated into a pure miss versus newly written cache content.

Official source: https://developers.openai.com/api/docs/guides/prompt-caching

Official Standard-tier GPT-5.6 prices per one million tokens on the access date:

| Model | Context band | Input | Cache read | Cache write | Output |
|---|---|---:|---:|---:|---:|
| `gpt-5.6-sol` | short | $4.00 | $0.40 | $5.00 | $20.00 |
| `gpt-5.6-sol` | long | $8.00 | $0.80 | $10.00 | $30.00 |
| `gpt-5.6-terra` | short | $2.00 | $0.20 | $2.50 | $12.00 |
| `gpt-5.6-terra` | long | $4.00 | $0.40 | $5.00 | $18.00 |
| `gpt-5.6-luna` | short | $0.20 | $0.02 | $0.25 | $1.20 |
| `gpt-5.6-luna` | long | $0.40 | $0.04 | $0.50 | $1.80 |

Official source: https://developers.openai.com/api/docs/pricing

Pricing tier/context band must be explicit input to price resolution. The registry must not infer Standard, Batch/Flex/Fast, regional processing, or long-context status from a model name alone.

#### ChatGPT/Codex OAuth (`gpt-oauth` runtime path)

Official Codex documentation recognizes ordinary and cached input as different subscription-credit dimensions, but does not promise that OAuth-backed Codex responses expose the public Platform API usage schema. It also does not define a reliable USD charge per request under a ChatGPT subscription.

Sources:

- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/pricing

Therefore:

- Parse raw Responses cache usage only when it is actually present in the Codex response.
- Mark those token values `reported`/`derived` according to their source.
- Do not attach OpenAI Platform USD prices to `provider = chatgpt-oauth`.
- If desired later, a separate `credits` pricing unit can be added, but it must not be formatted as dollars.

#### OpenCode Go

OpenCode Go is an OpenCode/Anomaly subscription provider reached through OpenCode-hosted `/zen/go/v1/responses`, `/chat/completions`, `/messages`, and `/models` endpoints. Official pricing contains Input, Output, Cached Read, and sometimes Cached Write columns, but official docs do not specify response usage fields, upstream routing, cache TTL, or whether upstream cache fields are preserved.

Sources:

- https://opencode.ai/go
- https://opencode.ai/docs/go/
- https://opencode.ai/docs/providers/

Consequences:

- Treat Go as provider `opencode-go`, not as OpenAI or DeepSeek based on model branding.
- Use Go's own product pricing, not the similarly named upstream provider's public pricing.
- Implement schema parsing only for observed/documented fixtures; unknown/missing fields produce `cacheTelemetry = unsupported | unknown`, never invented zeros.
- Some Go prices are time- or context-dependent, so the registry must support effective dates, context bands, and time bands.

#### DeepSeek direct API

Official DeepSeek Chat Completions usage exposes:

```text
usage.prompt_tokens
usage.completion_tokens
usage.prompt_cache_hit_tokens
usage.prompt_cache_miss_tokens
usage.total_tokens
```

`prompt_tokens = hit + miss` is documented. Cache write tokens are not reported.

Sources:

- https://api-docs.deepseek.com/guides/kv_cache
- https://api-docs.deepseek.com/api/create-chat-completion
- https://api-docs.deepseek.com/quick_start/pricing

Official 2026-08-22 direct API pricing per one million tokens:

| Model | Time band | Cache hit | Cache miss | Output |
|---|---|---:|---:|---:|
| `deepseek-v4-flash` | off-peak | $0.007 | $0.22 | $0.66 |
| `deepseek-v4-flash` | peak | $0.014 | $0.44 | $1.32 |
| `deepseek-v4-pro` | off-peak | $0.022 | $0.66 | $1.98 |
| `deepseek-v4-pro` | peak | $0.044 | $1.32 | $3.96 |
| `deepseek-v4-flash-vision-exp` | off-peak | $0.007 | $0.22 | $0.66 |
| `deepseek-v4-flash-vision-exp` | peak | $0.014 | $0.44 | $1.32 |

Peak periods on the research date were 01:00-04:00 UTC and 06:00-10:00 UTC. The announced weekend rule begins 2026-08-23 and must not be retroactively applied.

## Proposed Solution and Technical Contracts

### Scope boundary

Implement a reusable, zero-dependency CommonJS cache analytics layer in this plugin and wire it to the current GPT OAuth response flow. Define and test adapters for officially known OpenAI Responses/OpenAI-compatible/DeepSeek schemas. Keep OpenCode Go parsing conservative until real response fixtures establish a schema.

The plugin cannot directly render a ZCode transcript notice because no transcript/UI extension contract is present in this repository. The transport contract will therefore expose structured metadata, while rendering remains the host client's responsibility. The proxy may optionally log a concise local notice, but logs are not the primary UI.

### Modules and dependency direction

```text
Provider response
  -> Provider Usage Adapter
  -> NormalizedUsage
  -> Session/Lineage Tracker
  -> Cache Miss Detector
  -> Pricing Registry
  -> Incremental Cost Calculator
  -> CacheMissNotice DTO
  -> Chat Completions response extension / terminal SSE chunk
```

Dependencies flow only downward. Detector and calculator modules must never branch on `openai`, `deepseek`, `opencode-go`, or raw response field names.

### Normalized usage model

Create `server/cache/usage.js` with JSDoc contracts and validation helpers:

```js
/** @typedef {'reported'|'derived'|'estimated'} DataConfidence */
/** @typedef {'supported'|'unsupported'|'unknown'} TelemetrySupport */

/**
 * @typedef {Object} Metric
 * @property {number} value           // finite non-negative integer token count
 * @property {DataConfidence} confidence
 * @property {string} source          // raw field or derivation identifier
 */

/**
 * @typedef {Object} NormalizedUsage
 * @property {string} provider        // chatgpt-oauth | openai | opencode-go | deepseek
 * @property {string} model
 * @property {string|null} pricingTier
 * @property {string|null} sessionId
 * @property {string|null} lineageId
 * @property {number} observedAtMs
 * @property {TelemetrySupport} cacheTelemetry
 * @property {Metric|null} inputTokens       // total prompt/input, including cache buckets
 * @property {Metric|null} outputTokens
 * @property {Metric|null} cacheReadTokens
 * @property {Metric|null} cacheWriteTokens
 * @property {Metric|null} cacheMissTokens
 * @property {Metric|null} cacheHitRate
 */
```

Rules:

1. Missing is `null`, never zero.
2. Provider-returned fields are `reported`.
3. Exact arithmetic identities from reported fields are `derived`.
4. Heuristics are `estimated`; no estimated metric may silently replace a reported/derived one.
5. Invalid, negative, fractional, non-finite, or internally inconsistent counts cause the affected metric to become `null` and record a non-fatal diagnostic for tests/logging.
6. `cacheTelemetry = supported` only when an adapter sees a recognized cache field, even when its reported value is zero.
7. `cacheTelemetry = unsupported` is reserved for a provider/model capability explicitly known not to expose cache metrics. Absence in one response is otherwise `unknown`.
8. `cacheHitRate` is derived only when total comparable input is positive and cache-read tokens are known.

Adapter mapping:

| Provider/schema | Mapping | Confidence |
|---|---|---|
| OpenAI Responses / GPT OAuth when present | `input_tokens`, `output_tokens`, nested `cached_tokens`, nested `cache_write_tokens` | raw fields `reported`; `cacheMissTokens = max(0, input - read - write)` only as `derived` and named `ordinaryUncached` internally when semantics are ambiguous |
| OpenAI Chat Completions | `prompt_tokens`, `completion_tokens`, nested cached/write fields | same as above |
| DeepSeek | prompt/completion/hit/miss fields | all returned fields `reported`; hit rate `derived`; write `null` |
| OpenCode Go | parse only recognized fields actually present in a response fixture | retain provider identity `opencode-go`; never infer schema from branded model name |

The implementation should use an internal `uncachedInputTokens` value when OpenAI semantics do not justify calling every non-hit token a cache miss. A user-facing `cacheMissTokens` is populated directly for DeepSeek, or by the cross-request detector for comparable OpenAI-style requests.

### Session and comparison identity

A process-wide tracker is insufficient unless request continuity is explicit. Add an optional, backward-compatible request extension:

```json
{
  "cache_control": {
    "session_id": "opaque-host-session-id",
    "lineage_id": "opaque-context-lineage-id",
    "reset": false
  }
}
```

This local proxy field is consumed before forwarding and never sent upstream. Recommended host behavior:

- Stable `session_id` for one conversation/session.
- Stable `lineage_id` while prompt context is comparable.
- Change `lineage_id` after compaction, branch summary, manual context replacement, or history truncation.
- Set `reset: true` when the host knows prior context is no longer comparable.

If no `session_id` is supplied, normalized usage can still be returned, but cross-request miss detection is disabled to prevent false positives. Do not key sessions by OAuth account, source IP, model alone, or global daemon order.

Tracker key:

```text
provider + sessionId + lineageId
```

Store only the previous comparable usage snapshot per key in memory, with bounded least-recently-used eviction and no prompt text. Proposed defaults:

- Maximum 1,000 active keys.
- Expire tracker entries after 48 hours without observation.
- No persistence across daemon restart.

Model is deliberately not part of the tracker key so a model switch can be detected, but comparison eligibility rules below still apply.

### Cache miss detection algorithm

Detector input:

```js
detectCacheMiss(previousSnapshot, currentUsage, policy, pricingContext)
```

Eligibility gates, in order:

1. `cacheMissNotices` is enabled.
2. Current response completed successfully and contains valid usage.
3. Stable `sessionId` and `lineageId` exist.
4. A previous successful snapshot exists for the same provider/session/lineage.
5. Both total input counts are known and positive.
6. At least one cache metric has been reported in this lineage for this exact provider/schema capability.
7. Requests are semantically comparable: no reset, no lineage change, no known request truncation, and timestamps are monotonic after clamping.
8. A provider/model adapter does not mark the pair incompatible.

Missed/re-billed token selection:

```text
overlapTokens = min(previous.inputTokens, current.inputTokens)

if current.cacheMissTokens is directly reported and
   current.cacheReadTokens is directly reported:
    comparableMiss = min(overlapTokens, current.cacheMissTokens)
else if current.cacheReadTokens is reported/derived:
    comparableMiss = max(0, overlapTokens - current.cacheReadTokens)
else:
    no detection
```

For OpenAI-style telemetry with reported cache writes:

- Keep `overlap - cacheRead` as the Pi-compatible re-billed overlap measure.
- Do not subtract current `cacheWriteTokens` from re-billed overlap: write tokens may be previously seen context that had to be written again, which is part of the additional paid impact.
- Separately retain raw ordinary-uncached/write buckets for pricing.

For DeepSeek:

- `prompt_cache_miss_tokens` is reported for the whole current prompt.
- Clamp it by `overlapTokens` so newly appended prompt tokens are not mislabeled as re-billed old context.

Noise and notice thresholds, matching Pi defaults but configurable as policy constants:

```text
DETECTION_NOISE_FLOOR_TOKENS = 1_024
NOTICE_TOKEN_THRESHOLD       = 20_000
NOTICE_COST_THRESHOLD_USD    = 0.10
significant = missedTokens >= 20_000 OR additionalCostUsd >= 0.10
```

A detected miss below the noise floor is discarded. A valid but non-significant miss updates tracker/session statistics but produces no notice.

Idle and model-switch fields:

```text
idleMs = max(0, current.observedAtMs - previous.observedAtMs)
modelChanged = current.model !== previous.model
```

Do not use Pi's fixed five-minute label threshold globally. The notice contains factual `idleMs` whenever timestamps are known; renderers may say `after Xm idle` without claiming causality. An optional provider/model TTL hint may be included in pricing/capability metadata, but DeepSeek/OpenCode TTLs are not precise enough for a causal label.

State update rule: after every successful, valid current response, replace the prior snapshot even when no notice is emitted. Failed/aborted/missing-usage responses do not advance state.

### Pricing registry

Create `server/cache/pricing.js` with immutable data records separated from detection logic:

```js
/**
 * @typedef {Object} PriceRecord
 * @property {string} provider
 * @property {string} modelPattern
 * @property {string} currency       // USD or credits; never mix
 * @property {string} tier
 * @property {string} effectiveFrom  // ISO date/time
 * @property {string|null} effectiveTo
 * @property {Object} selector       // context/time/region/service-tier constraints
 * @property {number|null} inputPerMillion
 * @property {number|null} outputPerMillion
 * @property {number|null} cacheReadPerMillion
 * @property {number|null} cacheWritePerMillion
 * @property {number|null} cacheHitPerMillion
 * @property {number|null} cacheMissPerMillion
 * @property {string} sourceUrl
 * @property {string} retrievedAt
 */
```

Resolution API:

```js
resolvePricing({ provider, model, tier, observedAtMs, inputTokens, region })
// => { status: 'resolved', record } |
//    { status: 'ambiguous'|'not_found'|'unsupported', reason }
```

Rules:

- Exact provider identity is mandatory.
- Model aliases are explicit data, not fuzzy matching.
- Effective dates are evaluated against request time.
- Time bands use UTC where the official provider specifies UTC.
- Long-context bands use the provider's documented total/context basis.
- Ambiguous tier, region, context band, or billing unit means no USD estimate.
- Official source URL and retrieval date travel with each registry entry.
- Never scrape pricing per request.
- GPT OAuth has `not_found` for USD; do not reuse OpenAI Platform prices.
- OpenCode Go prices are keyed to `opencode-go` and its own tiers/time/context bands.
- DeepSeek rules are time-aware and versioned around announced schedule changes.

### Incremental additional-cost calculation

Return cost independently from token detection:

```js
calculateAdditionalCacheMissCost({ missedTokens, usage, priceResolution })
```

Preferred exact/derived formula when cache miss and hit prices are available:

```text
additionalCost = missedTokens * max(0, cacheMissRate - cacheHitRate) / 1_000_000
```

Equivalent OpenAI formula when ordinary input and cache-read prices are available:

```text
additionalCost = missedTokens * max(0, inputRate - cacheReadRate) / 1_000_000
```

When a provider charges cache writes and current usage exposes them, calculate the effective paid rate over re-billed paid buckets only if the allocation can be derived without guessing. Otherwise use the conservative input-vs-read delta and mark confidence `estimated`, or omit cost if even that tier is ambiguous.

Cost DTO:

```js
{
  value: 0.13,
  currency: 'USD',
  confidence: 'derived' | 'estimated',
  formula: 'cacheMissMinusHit' | 'inputMinusRead' | 'effectivePaidMinusRead',
  pricingSourceUrl: 'https://...',
  pricingEffectiveFrom: '...'
}
```

Never show a currency value when price resolution is ambiguous or absent. The renderer adds `~` for `estimated`, and may show an exact currency value without `~` only when all token counts, tiers, and rates are directly reported or exactly derived.

### Notice DTO and transport

```js
/** @typedef {Object} CacheMissNotice */
{
  type: 'cache_miss',
  provider: 'chatgpt-oauth',
  model: 'gpt-5.6-sol',
  sessionId: '...',
  observedAtMs: 1787437060000,
  idleMs: 1440000,
  modelChanged: false,
  rebilledTokens: { value: 29000, confidence: 'derived' },
  additionalCost: null,
  significant: true
}
```

Expose one backward-compatible response extension:

- Non-streaming response: top-level `cache_notice` only when a significant notice exists.
- Streaming response: top-level `cache_notice` attached to the terminal `chat.completion.chunk` before `[DONE]`.
- Normalized token details may be exposed as top-level `cache_usage` only when `cacheMissNotices` is enabled; do not mutate the standard OpenAI `usage` object with nonstandard fields.

This design avoids injecting fake assistant text, preserves tool-call/text ordering, and lets a future ZCode UI render:

```text
Cache miss after 24m idle: 29k tokens re-billed
```

or, only when cost is trustworthy:

```text
Cache miss after 24m idle: 29k tokens re-billed (~$0.13)
```

### Setting

Use an environment setting first because this repo has no settings UI or typed config layer:

```text
GPT_OAUTH_CACHE_MISS_NOTICES=1
```

Internal config name: `cacheMissNotices`, default `false`. The response/request extension is inert when disabled. Document that a future host-level multi-provider setting should map to this flag or send an explicit local request option; do not overload OAuth token storage.

## Shared Logic vs Provider-specific Logic

### Shared logic

- Metric validation and confidence propagation.
- Session/lineage tracker and bounded eviction.
- Comparable-overlap calculation.
- Noise/significance thresholds.
- Idle/model-switch metadata.
- Pricing resolution interface and effective-date selection.
- Incremental-cost formulas.
- Notice DTO and formatting helper.
- Failure behavior and telemetry omission.

### Provider-specific logic

- Raw response field paths and semantic validation.
- Whether cache support can be established from zero-valued fields.
- Model aliases and capability incompatibilities.
- Pricing records, context/time/tier selectors, official source URLs.
- Optional retention/TTL hints.

### Confidence examples

| Metric | Provider | Confidence |
|---|---|---|
| `cached_tokens` | OpenAI response | `reported` |
| `input - cached - write` | OpenAI GPT-5.6 | `derived` |
| cross-request `min(previous,current)-cacheRead` | OpenAI/Pi-style | `derived` re-billed overlap, not provider-reported miss |
| `prompt_cache_miss_tokens` | DeepSeek | `reported` current-request miss |
| DeepSeek comparable miss clamped to previous overlap | DeepSeek | `derived` re-billed overlap |
| price chosen without explicit service tier | Any tiered provider | omit, not estimated |
| conservative input-minus-read delta when write allocation is unknown | Supported provider | `estimated` and `~` in UI |
| absent Go cache field | OpenCode Go | `null`, never zero |

## Files to Create or Modify

### Create

- `server/cache/usage.js` — normalized contracts, validators, confidence helpers.
- `server/cache/adapters.js` — OpenAI Responses, OpenAI Chat Completions, DeepSeek, and conservative OpenCode Go adapters.
- `server/cache/detector.js` — tracker, comparison eligibility, Pi-compatible overlap detector, thresholds.
- `server/cache/pricing.js` — versioned official pricing registry and resolver.
- `server/cache/cost.js` — incremental cache-miss cost calculator.
- `server/cache/notice.js` — notice DTO assembly and renderer helper.
- `test/cache-usage.test.js` — adapter/normalization tests.
- `test/cache-detector.test.js` — detector/tracker tests.
- `test/cache-pricing.test.js` — price resolution and effective-date tests.
- `test/cache-integration.test.js` — non-streaming and streaming proxy integration tests with a local upstream fixture.
- `package.json` — dependency-free `node --test` scripts and Node engine declaration.

### Modify

- `server/server.js`
  - Load cache feature configuration.
  - Consume and strip local `cache_control` request metadata before `buildBackendBody`.
  - Normalize usage at `response.completed` in both `transformEvents` and `handleStream`.
  - Feed successful normalized usage into the tracker/detector.
  - Attach `cache_usage`/`cache_notice` to non-streaming responses and terminal streaming chunks.
  - Preserve current behavior when disabled or metadata is absent.
- `README.md`
  - Document the setting, request extension, response contract, confidence semantics, provider limitations, pricing provenance, and privacy behavior.
- `.zcode-plugin/plugin.json`
  - Bump version only during implementation/release, after tests pass.
- `server/server.js:34`
  - Keep runtime version synchronized with the manifest during implementation/release.
- `docs/plans/2026-08-22-2217-multi-provider-cache-miss-notices.md`
  - Mark approved/completed and record execution/test results.

No changes are planned for OAuth token persistence, `.mcp.json`, login/logout flows, or user provider secrets.

## Workstreams

### Workstream 1: Shared cache analytics and tests

- Agent: `worker`
- Owned files:
  - `server/cache/usage.js`
  - `server/cache/adapters.js`
  - `server/cache/detector.js`
  - `server/cache/pricing.js`
  - `server/cache/cost.js`
  - `server/cache/notice.js`
  - `test/cache-usage.test.js`
  - `test/cache-detector.test.js`
  - `test/cache-pricing.test.js`
  - `package.json`
- Implementation blueprint:
  1. Implement the exact JSDoc contracts and null/confidence rules above.
  2. Keep raw provider paths exclusively in `adapters.js`.
  3. Implement tracker keys as provider/session/lineage with LRU/expiry bounds.
  4. Implement eligibility gates and overlap formulas exactly as specified.
  5. Seed pricing only from the official records cited above; GPT OAuth USD must remain unresolved.
  6. Use Node's built-in `node:test` and `assert/strict`; add no runtime dependency.
- Verification:
  - `npm test`
  - `node --test test/cache-usage.test.js test/cache-detector.test.js test/cache-pricing.test.js`

### Workstream 2: Proxy integration, transport, and docs

- Agent: `worker`
- Owned files:
  - `server/server.js`
  - `test/cache-integration.test.js`
  - `README.md`
  - `.zcode-plugin/plugin.json`
- Upfront contract with Workstream 1:

  ```js
  normalizeProviderUsage({ provider, schema, model, rawUsage, observedAtMs, sessionId, lineageId, pricingTier })
  tracker.observe(normalizedUsage, { reset })
  buildCacheNotice(detection, priceResolution)
  ```

- Implementation blueprint:
  1. Parse `GPT_OAUTH_CACHE_MISS_NOTICES` once at startup; default false.
  2. Read and strip local `cache_control` before upstream serialization.
  3. Call the GPT OAuth/OpenAI Responses adapter only when `response.completed.response.usage` exists.
  4. Advance tracker only on successful completion.
  5. Add extensions only to final complete responses/chunks and only while enabled.
  6. Keep unknown/malformed cache metadata non-fatal and preserve current usage output.
  7. Build a local fake SSE upstream using `GPT_OAUTH_BACKEND_BASE`; verify token-by-token ordering, tool calls, terminal metadata, and `[DONE]`.
  8. Document that structured notice rendering requires host/client support.
- Verification:
  - `node --check server/server.js`
  - `node --test test/cache-integration.test.js`
  - `npm test`

Workstreams can run in parallel after approval because their owned files do not overlap. Workstream 2 must initially code to the upfront interface contract; integration discrepancies go back to the owning worker.

## Edge Cases and Required Tests

### Normalization

- Usage absent entirely.
- Cache detail object absent versus present with explicit zero values.
- OpenAI cached tokens only; cached plus write tokens; totals smaller than buckets.
- DeepSeek hit plus miss equals total; mismatch; missing one field.
- OpenCode Go OpenAI-compatible shape present; unknown shape absent.
- Negative, fractional, string, NaN, infinite, and overflow values.
- Output tokens available while input/cache fields are absent.
- Confidence never upgrades from estimated to reported.

### Detection

- First request produces no miss.
- No session or lineage identifier disables comparison.
- Same session but different lineage produces no miss.
- Explicit reset clears state.
- Provider switch does not compare across provider keys.
- Model switch within a provider is detected and labeled without assuming the metrics are compatible.
- Healthy full/partial cache hit.
- Complete cache miss after prior cache-support evidence.
- All-zero cache fields before any support evidence do not trigger a miss.
- Newly appended prompt tokens excluded by `min(previous,current)`.
- Prompt shrink/truncation uses overlap only.
- Exactly 1,024 missed tokens is discarded; 1,025 is retained internally.
- Notice boundary at 20,000 tokens and $0.10.
- Negative/out-of-order timestamps clamp idle to zero.
- Failed/aborted/missing-usage response does not advance state.
- Concurrent interleaved sessions do not contaminate each other.
- LRU and 48-hour expiry remove stale snapshots.
- Daemon restart loses state gracefully.

### Pricing and cost

- Exact provider+model+tier resolution.
- OpenAI short versus long context.
- DeepSeek peak boundary and off-peak boundary in UTC.
- Effective-date transition at the announced pricing schedule.
- OpenCode Go model-specific/time/context price resolution.
- Ambiguous service tier/region/context produces tokens-only notice.
- GPT OAuth never resolves to OpenAI Platform USD rates.
- Cache miss minus hit and input minus read formulas.
- Cache write rate handled only with adequate allocation data.
- Negative price delta clamps to zero.
- Missing rate omits cost.
- Estimated cost uses `~`; derived/exact cost does not.
- Currency units never mix.

### Proxy integration

- Feature disabled: byte-compatible response shape with current behavior.
- Feature enabled but no cache metadata: normal response, no notice.
- Non-streaming significant notice appears at top level.
- Streaming notice appears only on terminal chunk, before `[DONE]`.
- Text/tool-call chunks retain existing order and content.
- Split/CRLF/multi-line SSE parsing remains correct.
- Upstream error emits no notice and does not advance tracker.
- Client disconnect leaves no partial snapshot.
- Local `cache_control` never reaches upstream.
- Secrets, prompt text, account ID, and cache session IDs are not logged.

## Failure Behavior

- Unsupported or unknown cache metadata: return normal completion; omit cache fields/notice.
- Missing usage: return normal completion; do not update comparison state.
- Missing pricing: detect/report tokens if possible; omit money.
- Ambiguous pricing tier: omit money rather than choose a default.
- Invalid provider metric: ignore the affected metric, retain valid standard usage, log only a non-sensitive diagnostic when useful.
- Tracker eviction/restart: next request becomes a new baseline.
- Notice serialization failure: completion must still succeed; cache analytics is non-critical.

## Risks and Open Decisions

- Decision: Where should notices be rendered?
  - Recommendation: expose structured `cache_notice` in this proxy and let ZCode/client UI render it. This repo has no transcript UI extension point, so injecting assistant text would corrupt model output.
- Decision: How is session comparability established?
  - Recommendation: require explicit local `cache_control.session_id` and `lineage_id`. Global daemon ordering or account/model keys would create false positives across concurrent subagents.
- Decision: Should GPT OAuth show USD cost using OpenAI API pricing?
  - Recommendation: no. Official docs distinguish subscription/Codex access from Platform API billing. GPT OAuth should be tokens-only until an official billing unit and telemetry mapping are available.
- Decision: Should OpenCode Go inherit upstream model schemas/prices?
  - Recommendation: no. Keep provider identity and product pricing as `opencode-go`; parse only observed fields and version fixture assumptions.
- Decision: Should the setting be enabled by default?
  - Recommendation: default false, matching Pi and preserving exact current response compatibility.
- Decision: Should all small misses be shown?
  - Recommendation: retain Pi defaults: discard <=1,024-token noise and display at >=20,000 tokens or >=$0.10 incremental cost.
- Decision: Should notices persist?
  - Recommendation: no persistence in this plugin. Retain one bounded in-memory previous snapshot; a daemon restart safely resets the baseline. Transcript reconstruction belongs in the host that persists session usage.

## Integration and Review Gate

This feature touches asynchronous streaming state and billing/security-adjacent metadata, so it qualifies for direct high-risk review after subagent implementation. The parent agent will:

1. Mark this plan `Status: Approved` after explicit user approval.
2. Dispatch the two isolated worker scopes concurrently.
3. Reconcile the agreed module contracts without directly editing implementation files.
4. Run the complete test suite and static syntax checks.
5. Review streaming completion ordering, session isolation, confidence propagation, and price-provider separation.
6. Delegate any corrections to the owning worker and re-run verification.
7. Synchronize versions only after all checks pass.
8. Mark this plan `Status: Completed` with exact execution notes.

## Verification Plan

```bash
node --check server/server.js
node --check server/cache/usage.js
node --check server/cache/adapters.js
node --check server/cache/detector.js
node --check server/cache/pricing.js
node --check server/cache/cost.js
node --check server/cache/notice.js
npm test
```

Acceptance criteria:

- Existing completions and streams are unchanged when disabled.
- Cache metadata is never invented.
- Detection cannot cross provider/session/lineage boundaries.
- A significant miss can produce re-billed tokens without requiring pricing.
- Cost is strictly incremental and appears only with a trustworthy provider/model/tier resolution.
- GPT OAuth does not display fake OpenAI Platform dollar costs.
- OpenCode Go does not masquerade as an upstream provider.
- Missing metadata/pricing never crashes or fails a completion.
- Streaming text/tool chunks remain incremental and ordered.

## Execution Notes

- Implemented provider-neutral normalized usage, confidence metadata, provider adapters, bounded session/lineage tracking, two-phase preview/commit detection, pricing resolution, incremental cost calculation, and notice assembly under `server/cache/`.
- Integrated opt-in `GPT_OAUTH_CACHE_MISS_NOTICES` behavior into non-streaming and streaming proxy paths. Local `cache_control` metadata is stripped before upstream forwarding.
- Added cancellation and hard bounds for in-flight request generations. Failed, disconnected, evicted, stale, and superseded requests cannot commit cache baselines.
- Non-streaming state commits only after the response end callback. Streaming state commits only after terminal metadata and `[DONE]` writes are accepted.
- Added real spawned-proxy integration tests with a local Responses SSE fixture, including sequential notice detection, metadata stripping, stream ordering, upstream failure, client disconnect, and disabled behavior.
- Preserved provider/pricing separation: ChatGPT OAuth does not inherit OpenAI Platform USD pricing; OpenCode Go uses its own provider identity and official product pricing records.
- Synchronized runtime, plugin, marketplace, nested marketplace, and package versions to `0.2.4`.
- Final verification: `git diff --check`, syntax checks for the server/cache/test JavaScript files, JSON/version consistency checks, and `npm test` all passed. Test result: 20 passed, 0 failed.
