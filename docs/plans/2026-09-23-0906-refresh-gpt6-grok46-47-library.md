# Implementation Plan: Refresh the installed model library to GPT-6 and Grok 4.6/4.7

## Status
- Status: Completed
- Created: 2026-09-23 09:06
- Approved: Yes, 2026-09-23

## Execution Notes
- Delivered on the working tree, not committed. Version is `0.3.4`.
- Registry, proxy, and tests: `scripts/setup-provider.js`, `server/server.js` (`VERSION`, `MODEL_IDS`, `XAI_MODEL_IDS`, `REASONING_EFFORTS`), `test/setup-provider.test.js`, `test/xai-proxy.test.js`, `test/reasoning-effort.test.js`.
- Docs and the other release refs: `package.json`, `.zcode-plugin/plugin.json`, `.zcode-plugin/marketplace.json`, `marketplace.json`, `server/xai-oauth.js`, `commands/gpt-oauth/setup.md`, `README.md`.
- Fixture-only follow-up: `test/cache-integration.test.js` and `test/request-body-cap.test.js` now post `gpt-6-astra` instead of the retired `gpt-5.6-sol`. Pricing fixtures were left alone.
- Prune was narrowed after review. Setup removes only the eight retired ids from the `gpt-oauth` provider. A hand-added model on that provider is kept. Other providers are not touched. Test 12 covers the hand-added case.
- `npm test`: **73 pass / 0 fail**.
- Isolated proxy on port 8799 (production 8787 untouched, then stopped): `/healthz` reported `version 0.3.4` and `modelCount 5`; `/v1/models` listed exactly `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `grok-4.7`, `grok-4.6`. Non-streaming completions for `gpt-6-sol` and `gpt-6-luna` returned HTTP 200 with text `pong`. `gpt-5.6-sol` returned HTTP 404.
- Live `~/.zcode/v2` was not modified. The picker updates only when the user runs `/gpt-oauth:setup` on the installed 0.3.4 helper and restarts ZCode.

## Request Summary
After install, the `gpt-oauth` library must expose only the current GPT-6 models and Grok 4.6 plus Grok 4.7. Older GPT-5.6 and older Grok ids must disappear from the proxy inventory and from the ZCode picker. Ship as version `0.3.4`.

## Verification Performed Before Planning (read-only)
- Live xAI `GET /v1/models` with the stored OAuth token returned HTTP 200 and 13 ids. Text/tool ids include `grok-4.7` and `grok-4.6`; also still present are `grok-4.5`, `grok-4.3`, `grok-build-0.1`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-4.20-multi-agent-0309`, and `grok-imagine-*`. No newer Grok text id exists. `grok-imagine-*` stays excluded (not a chat-completions model).
- OpenAI models index (2026-09-23) lists the flagship GPT-6 family as exactly three slugs: `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`. There is no `gpt-6-terra`. The only remaining GPT-5.6 card is `gpt-5.6-cyber`, which is out of scope.
- Official docs, quoted for the two new ids:
  - `gpt-6-sol`: context 1,050,000, max output 128,000, knowledge cutoff Apr 20 2026, input text/image, output text, reasoning effort `none|low|medium|high|xhigh|max` (default medium).
  - `gpt-6-luna`: context 1,050,000, max input 922,000, max output 128,000, knowledge cutoff May 18 2026, input text/image, output text, same effort enum including `none` (default medium).
  - `gpt-6-astra` docs still list effort `low|medium|high|xhigh|max` (no `none`). Do not widen astra's effort set in this change.
- Live Codex subscription probe (`POST https://chatgpt.com/backend-api/codex/responses`, stored token, no secrets logged): `gpt-6-sol` and `gpt-6-luna` both returned HTTP 200, `response.completed`, and the text `pong`. `gpt-6-sol` with `reasoning.effort = none` also returned HTTP 200 and `pong`. A non-streaming `Accept: application/json` probe returned HTTP 400 with an empty body; the working wire format is the existing SSE path (`stream: true`).
- Running proxy on `127.0.0.1:8787` is still v0.3.3 and advertises the old 11 ids. It was not modified.

## Repository Findings & Exact References
- `server/server.js:114` — `MODEL_IDS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']`. `providerForModel` (`server/server.js:163-166`) only routes an id to OpenAI when it is in this array, so the two new ids must be added here or the proxy 404s them.
- `server/server.js:120` — `REASONING_EFFORTS` is already `low|medium|high|xhigh|max`. `none` is absent, so a client think-level of `none` is currently dropped before it reaches Codex.
- `server/server.js:158-161` — `XAI_MODEL_IDS` lists seven Grok ids. This is the proxy inventory behind `/v1/models` (`server/server.js:2237`) and `modelCount` (`server/server.js:2216`).
- `scripts/setup-provider.js:36-45` — `GPT_MODEL_IDS` is the four old GPT ids; `GROK_MODEL_IDS` is the seven Grok ids. `ALL_MODEL_IDS` derives from both.
- `scripts/setup-provider.js:88-123` and `134-179` — `PROVIDER_MODEL_RULES` and `LEGACY_MODEL_SPECS` have one entry per current id. New GPT ids need entries; retired ids must be deleted from both maps.
- `scripts/setup-provider.js:344-364` and `407-414` — merge is append-only. Removing an id from `ALL_MODEL_IDS` does **not** remove it from an existing `personalModelIds`, `modelOrder`, `providerModelRules`, or legacy `models` map. A prune step is required or the picker keeps GPT-5.6 and old Grok after setup.
- `scripts/setup-provider.js:547-561` and `564-578` — the summary reports only added ids. It must also report removed ids so `/gpt-oauth:setup` can tell the user what left the picker.
- `commands/gpt-oauth/setup.md:7,85,95,106` — hardcodes "eleven models (four GPT + seven Grok)" and lists the old ids.
- `README.md:24` — current version note is v0.3.3 / Grok 4.7.
- `test/xai-proxy.test.js:85,88` — asserts `ids.length === 11` and `health.modelCount === 11`.
- `test/reasoning-effort.test.js:106-121` — the no-effort case and the models-list case still name `gpt-5.6-sol` and require the three GPT-5.6 ids.
- `test/setup-provider.test.js:171-257` — asserts old Grok shapes (`grok-4.3`, `grok-4.20-0309-reasoning`) and titles the second test "seven Grok models". Assertions that import `ALL_MODEL_IDS` follow the constant; the hardcoded old-id blocks do not.
- Version string `0.3.3` is duplicated at seven release sites: `package.json:3`, `.zcode-plugin/plugin.json:4`, `.zcode-plugin/marketplace.json:8`, `marketplace.json:10`, `server/server.js:41` (`VERSION`), `server/xai-oauth.js:23` (`XAI_USER_AGENT`), `README.md:24`.
- `preset/agents/ui-expert.md:5` pins `gpt-5.6-sol`. That file is a local preset, not the installed library. Leave it unchanged.
- `server/cache/pricing.js` has GPT-5.6 rows and no xAI rows. Leave it unchanged; pricing is a separate follow-up.

## Proposed Solution & Technical Contracts

Target installed set, newest-first, exactly five ids:

```js
const GPT_MODEL_IDS = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
const GROK_MODEL_IDS = ['grok-4.7', 'grok-4.6'];
```

`server/server.js` `MODEL_IDS` must equal `GPT_MODEL_IDS` (astra, sol, luna — not the old setup-provider order). `XAI_MODEL_IDS` must equal `GROK_MODEL_IDS`.

Retired ids, removed from both inventories and pruned from this provider only:

`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.5`, `grok-4.3`, `grok-build-0.1`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`.

### 1. `server/server.js`
- `VERSION` → `'0.3.4'`.
- Replace `MODEL_IDS` and `XAI_MODEL_IDS` with the target lists above.
- Extend `REASONING_EFFORTS` to `['none', 'low', 'medium', 'high', 'xhigh', 'max']`. `buildBackendBody` already forwards a member of that set as `reasoning: { effort, summary: 'auto' }` plus `include: ['reasoning.encrypted_content']`. `none` was verified on `gpt-6-sol`. Invalid values such as `minimal` stay dropped. Do not special-case per model.

### 2. `scripts/setup-provider.js`
Replace the two id arrays. Delete the five retired Grok entries and the three GPT-5.6 entries from `PROVIDER_MODEL_RULES` and `LEGACY_MODEL_SPECS`.

Add, mirroring the existing `gpt-6-astra` shapes (context stays 256000, matching the astra registration decision, not the 1.05M docs figure):

```js
'gpt-6-sol': providerModelRule({ contextWindow: 256000 }),
'gpt-6-luna': providerModelRule({ contextWindow: 256000 }),
```

```js
'gpt-6-sol': legacyModel({
  context: 256000,
  output: 128000,
  reasoning: { enabled: true, variants: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultVariant: 'medium' },
}),
'gpt-6-luna': legacyModel({
  context: 256000,
  output: 128000,
  reasoning: { enabled: true, variants: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultVariant: 'medium' },
}),
```

Do not rewrite the existing `gpt-6-astra` legacy variants (`low` through `max`, default `high`). Docs for astra still omit `none`.

Keep `grok-4.7` and `grok-4.6` rule/spec objects byte-for-byte as they are today, including the known `maxOutputTokens: 128000` vs legacy `output: 500000` mismatch. Do not reconcile that here.

#### Prune contract
Inside `mergeProviderConfig`, after the existing append loop, for the resolved `gpt-oauth` `providerId` only:

- Filter `ruleConfig.personalModelIds` and `ruleConfig.modelOrder` to drop any string not in `ALL_MODEL_IDS`. Preserve relative order of ids that stay. Then append any missing target ids (existing `appendMissingIds`). Net order for a current install becomes the three surviving/new GPT ids in their old relative order, followed by `grok-4.7`, `grok-4.6`, then any other non-library ids are gone.
- Actually require the final two arrays to equal `ALL_MODEL_IDS` when every surviving id is one of the library ids. Implementation: remove ids not in `ALL_MODEL_IDS`, then if the remaining list is a subsequence of `ALL_MODEL_IDS`, replace it with `ALL_MODEL_IDS`. That puts `gpt-6-sol` and `gpt-6-luna` in the documented newest-first order instead of leaving them stuck at the tail. Do this only for these two arrays on this provider.
- Remove `providerModelRules` entries whose `providerId` is this provider and whose `modelId` is not in `ALL_MODEL_IDS`. Do not touch another provider's rules. Do not touch `manualProviderModelRules`.
- Return `removedModelIds` (ids dropped from either list, deduped, in first-seen order) and `removedProviderModelRuleIds`.

Inside `mergeLegacyConfig`, delete keys of this provider's `models` object that are not in `ALL_MODEL_IDS`. Return `removedModelIds`. Do not delete or reshape any other provider.

`runSetup` summary and `formatSummary` add three lines:

- `removed model ids (N): ...`
- `removed model rules (N): ...`
- `removed legacy model ids (N): ...`

Empty lists print `(none)`, matching the added-id formatter. Second run on an already-pruned home prints `(none)` for both added and removed, and writes nothing (existing idempotency).

Backup-first behavior stays. Prune runs only after both files have been read and schema-validated. A schema mismatch still throws before any write.

### 3. Docs and version
- `commands/gpt-oauth/setup.md`: "five models (three GPT-6 + two Grok)". List `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `grok-4.7`, `grok-4.6` in Step 6 and the manual fallback. Mention that setup removes previously registered GPT-5.6 and older Grok ids from this provider only, after writing a `.bak-<timestamp>`. Example helper path may say `0.3.4`.
- `README.md:24`: v0.3.4 note — library is now GPT-6 (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`) and Grok 4.6/4.7 only; older ids are removed from the proxy and pruned from the provider registry on setup. Keep the image/video caveat.
- Bump `0.3.3` → `0.3.4` at the seven release sites listed above. Do not edit historical plan docs.

### 4. Tests
- `test/xai-proxy.test.js`: `ids.length` and `health.modelCount` become `5`. Assert the five target ids are present and `gpt-5.6-sol` / `grok-4.5` are absent.
- `test/reasoning-effort.test.js`: no-effort case may keep using `gpt-6-astra` (change the fixture model off `gpt-5.6-sol`). Add one case: `model: 'gpt-6-sol'`, `reasoning_effort: 'none'` → upstream `reasoning.effort === 'none'`. Models-list test asserts the three GPT-6 ids and asserts `gpt-5.6-sol` is absent.
- `test/setup-provider.test.js`:
  - Drop assertions on `grok-4.3` and `grok-4.20-0309-reasoning`.
  - Add `gpt-6-sol` / `gpt-6-luna` shape assertions for both registries.
  - Rename the GPT-only fixture test; expected added ids are only the two Grok ids when the fixture already has the three GPT-6 ids. Update the fixture builder so its seeded GPT ids are the new `GPT_MODEL_IDS`, not the old four.
  - New test: a home seeded with the old 11-id registry (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, then the seven old Grok ids) plus a second unrelated provider that also lists `gpt-5.6-sol`. After `runSetup`, gpt-oauth lists exactly `ALL_MODEL_IDS` in both arrays and both model maps; the unrelated provider still lists `gpt-5.6-sol`; summary `removedModelIds` contains the eight retired ids (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.5`, `grok-4.3`, `grok-build-0.1`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`); a second run removes nothing and does not rewrite the files.

## Out of Scope
- `server/cache/pricing.js` and Grok price rows.
- Reconciling Grok `maxOutputTokens` 128000 vs legacy output 500000.
- `preset/agents/ui-expert.md` pin.
- `gpt-5.6-cyber`, Daybreak, realtime, image, and `grok-imagine-*` / `grok-4.20-multi-agent-0309`.
- Writing the live `~/.zcode/v2` files or restarting the user's 8787 daemon. Those happen only when the user runs `/gpt-oauth:setup` after install.
- Commit, push, or plugin-cache install. Not requested.

## Verification Steps
1. `npm test` — full suite green. Expect the previous 70 plus the new prune and `none`-effort cases.
2. `node --check server/server.js` and `node --check scripts/setup-provider.js`.
3. Isolated proxy (not port 8787): `GPT_OAUTH_PROXY_PORT=8799 node server/server.js --http-only`, then `GET /v1/models` returns exactly the five ids and `/healthz` reports `version: 0.3.4`, `modelCount: 5`. Stop that process.
4. One real `POST /v1/chat/completions` through that isolated proxy for `gpt-6-sol` and one for `gpt-6-luna` (non-stream), expecting HTTP 200. Do not print tokens.
5. Fixture-home `runSetup` seeded from a copy of the current registries: gpt-oauth ends at the five ids, the `deepseek` provider is unchanged, backups exist, second run is a no-op, and the summary contains no secret.

## Open Questions
None. The user asked for the GPT-6 family and only Grok 4.6/4.7. The live catalogs confirm that family is `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna`, and no newer Grok text id exists.
