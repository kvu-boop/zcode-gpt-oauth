# Add GPT-6 Astra model + think-level (reasoning effort) support

Status: Completed (2026-09-08)

## Execution notes

- Implemented by worker subagent per spec; reviewed diff matches exactly (server.js MODEL_IDS/REASONING_EFFORTS/buildBackendBody, setup.md astra entry first + fallback line, README 3 mentions + Think levels subsection, version 0.2.8 ×5 files, new test/reasoning-effort.test.js).
- Integration gate: `npm test` full suite 39/39 pass (35 pre-existing + 4 new); `node --check` clean; no existing test asserted on the model list so no assertion edits were needed.
- pricing.js, preset/, other commands, gpt-5.6 wire format: untouched (per user decisions).
- Pending user action: restart ZCode so the daemon upgrades to 0.2.8, then re-run `/gpt-oauth:setup` to register `gpt-6-astra` + reasoning variants in ZCode model settings.

Date: 2026-09-08 13:26

## Background — verified facts

- **`gpt-6-astra` is real and released** (Sep 3–4 2026). Official API slug `gpt-6-astra`. Specs: 1.05M context, 128K max output, knowledge cutoff Apr 30 2026.
- **Verified live on this machine (2026-09-08)**: through the running local proxy (`model=gpt-6-astra`) → HTTP 200 with real generation. Also direct `POST https://chatgpt.com/backend-api/codex/responses` with `reasoning:{effort, summary:"auto"}` + `include:["reasoning.encrypted_content"]` → HTTP 200 + `response.completed` for `effort` ∈ {`low`, `xhigh`, `max`}.
- **Think levels (per opencode v1.18.29 binary on this machine — `~/.opencode/bin/opencode`)**: `openai/gpt-6-astra` declares `reasoning_options:[{type:"effort", values:["low","medium","high","xhigh","max"]}]` (5 values; UI names Light/Medium/High/Extra High + Max). When an effort is selected opencode sends, on the Responses API: `reasoning:{effort:<v>, summary:"auto"}` and `include:["reasoning.encrypted_content"]` (kept when `store:false`).
- **Gap**: `buildBackendBody` (server/server.js:1031) drops `reasoning_effort` today, and registered gpt-oauth models in ZCode config have no `reasoning` block → think level can't work end-to-end.
- ZCode model config think-level format (from `~/.zcode/v2/config.json`): `"reasoning": {"enabled": true, "variants": [...], "defaultVariant": "..."}`.
- SSE forwarder already ignores unknown events (server.js:1769–1770), so astra/reasoning-summary events won't break streaming. `buildBackendBody` is shared by both stream + non-stream paths (called at server.js:1454, 1584).

## User decisions (2026-09-08)

1. **Add** `gpt-6-astra` alongside existing `gpt-5.6-*` (do not replace).
2. Must **not affect the current gpt-5.6 flow** (no reasoning params unless client sends a valid effort).
3. **No** pricing.js changes.
4. ZCode registration context limit for astra: **256000** (like siblings).
5. Request format follows **opencode v1.18.29** (verified above).

## Changes (single worker subagent)

### 1. `server/server.js`

- Line 40: `const VERSION = '0.2.8';`
- Line 113:
  ```js
  const MODEL_IDS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
  ```
- Near MODEL_IDS add:
  ```js
  // Efforts accepted by the ChatGPT Codex backend for gpt-6-astra (matches
  // opencode v1.18.29 reasoning_options). Anything else is dropped so requests
  // without a valid effort keep the exact pre-astra wire format.
  const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  ```
- `buildBackendBody` return (~line 1121), after `stream: true,`:
  ```js
    reasoning: REASONING_EFFORTS.has(body.reasoning_effort) ? { effort: body.reasoning_effort, summary: 'auto' } : undefined,
    include: REASONING_EFFORTS.has(body.reasoning_effort) ? ['reasoning.encrypted_content'] : undefined,
  ```
  (`undefined` values are dropped by JSON.stringify, matching the existing `tools:` pattern; pairing effort+summary+include mirrors opencode.)

### 2. `commands/gpt-oauth/setup.md`

- JSON template: add as FIRST model (keep the three gpt-5.6 entries unchanged):
  ```json
  "gpt-6-astra":   { "reasoning": { "enabled": true, "variants": ["low", "medium", "high", "xhigh", "max"], "defaultVariant": "high" }, "limit": { "context": 256000, "output": 128000 }, "modalities": { "input": ["text", "image"], "output": ["text"] } },
  ```
- Fallback (manual UI) "Add models" line: add `gpt-6-astra`.

### 3. `README.md`

- Line 26 registration list + line 46 example: mention `gpt-6-astra` alongside `gpt-5.6-*`.
- "Verified working model ids" (lines 143–145): add `gpt-6-astra` (verified 200 through the proxy AND with reasoning efforts low/xhigh/max against the backend, 2026-09-08).
- New short subsection "Think levels (gpt-6-astra)": Light/Medium/High/Extra High/Max → `reasoning_effort` `low/medium/high/xhigh/max`; forwarded since v0.2.8 as `reasoning:{effort,summary:"auto"}` + `include:["reasoning.encrypted_content"]` (per opencode v1.18.29, backend-verified); requests without a valid effort are byte-identical to before (gpt-5.6 unaffected); existing installs must re-run `/gpt-oauth:setup` (or add the `reasoning` block manually) to get the variants.

### 4. Version bump → `0.2.8` (5 places)

`server/server.js` VERSION + `package.json` + `.zcode-plugin/plugin.json` + `.zcode-plugin/marketplace.json` + `marketplace.json`.

### 5. Tests

- **New** `test/reasoning-effort.test.js` (copy the harness from `test/request-body-cap.test.js`: temp HOME + auth.json fixture, `GPT_OAUTH_BACKEND_BASE` pointing at a capturing fixture server, spawn `server/server.js --http-only`, `GPT_OAUTH_PROXY_PORT` on an ephemeral port):
  1. `reasoning_effort:"high"` → captured upstream body has `reasoning:{effort:"high",summary:"auto"}` and `include:["reasoning.encrypted_content"]`;
  2. `reasoning_effort:"minimal"` (legacy/invalid) → upstream body has NO `reasoning` and NO `include` keys, proxy still returns 200;
  3. no `reasoning_effort` → same as (2);
  4. `GET /v1/models` contains `gpt-6-astra` and still contains the three `gpt-5.6-*` ids.
- Run `npm test` (full suite) and `node --check server/server.js`; fix only tests that actually assert on the old 3-model list (grep candidates: test/cache-integration.test.js, test/cache-usage.test.js, test/request-body-cap.test.js, test/cache-pricing.test.js).

### 6. Out of scope (user decisions)

- `server/cache/pricing.js` — unchanged.
- `preset/agents/*.md`, `commands/*/login.md`, `setup-agents.md` example mentions — unchanged.
- No changes to gpt-5.6 request wire format.

## Post-implementation verification (Parent)

- `npm test` green; `node --check` clean.
- Manual (after daemon restart): curl proxy with `model=gpt-6-astra` + each effort → 200.

Status: Approved
