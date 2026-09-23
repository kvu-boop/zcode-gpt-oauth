# Align GPT thinking effort with Codex

## Status
- Status: Completed
- Created: 2026-09-23 10:15
- Approved: Yes
- Completed: 2026-09-23

## Request Summary
Update GPT thinking-effort choices exposed by the plugin to align with the documented GPT/Codex levels. The user reports Codex UI labels from Light through Extra High.

## Repository Findings & Exact References
- `scripts/setup-provider.js:91-108` defines canonical provider model rules. GPT-6 models currently have only `contextWindow`; no `reasoningLevel` `optionSpecs` are exposed in the current model picker.
- `scripts/setup-provider.js:118-147` defines legacy reasoning variants. Astra has `low/medium/high/xhigh/max`; Sol and Luna also have `none`.
- `scripts/setup-provider.js:336-372` adds canonical rules only when missing and retains existing rules. Any update must update the managed GPT rule's effort values on subsequent setup runs while preserving unrelated config fields.
- `server/server.js:117-118,1195-1196` accepts and forwards `none/low/medium/high/xhigh/max` as `reasoning.effort`. The transport already supports the proposed Codex range, so no wire-format change is expected.
- `test/setup-provider.test.js:169-200,220-235` asserts current registry and legacy effort shape. `test/reasoning-effort.test.js` covers proxy forwarding.
- Official OpenAI reasoning guide: https://developers.openai.com/api/docs/guides/reasoning — values are model-dependent and can include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; GPT-6 Astra does not support `none`. Codex UI terminology Light/Medium/High/Extra High maps to API values `low/medium/high/xhigh`.

## Proposed Solution & Technical Contracts
- Expose `reasoningLevel` values `['low', 'medium', 'high', 'xhigh']` in canonical model rules for all three GPT-6 models, matching Codex's Light–Extra High selector and the GPT proxy's supported API values.
- Align legacy GPT-6 variants to the same four selectable values so older ZCode registry consumers do not offer a different set. Keep the existing per-model default variants (Astra `high`; Sol/Luna `medium`).
- Do not expose `none` (Astra explicitly rejects it; keep behavior consistent among the GPT models in the picker), `minimal` (not accepted by the proxy), or `max` (OpenAI API availability is model-dependent, and it is outside the requested Codex Light–Extra High range).
- On setup refresh, merge the managed GPT `reasoningLevel` option spec into existing GPT provider model rules without replacing unrelated model config. Existing manual effort choices for unrelated models/providers remain untouched.
- No changes to backend forwarding allowlist or request wire format.

## Workstreams

### Workstream 1: GPT effort registration and tests
- Agent: worker
- Owned Files: `scripts/setup-provider.js`, `test/setup-provider.test.js`
- Implementation Steps & Code Blueprint:
  1. Add `reasoningLevelValues: ['low', 'medium', 'high', 'xhigh']` to each GPT model's `PROVIDER_MODEL_RULES` definition.
  2. Update `mergeProviderConfig` to apply the managed GPT `optionSpecs.reasoningLevel.values` to existing GPT model rules as well as newly created ones, retaining any other properties/option specs.
  3. Set GPT legacy variants to `['low', 'medium', 'high', 'xhigh']`, preserving current defaults.
  4. Update setup tests to assert all GPT model rules expose exactly those four choices and existing GPT rules are refreshed idempotently while unrelated fields survive; update legacy assertions accordingly.
- Verification: `npm test`.

## Integration & Shared Work
No parallel workstreams; proxy behavior and its tests remain unchanged. Parent runs the full test suite and reviews the managed-rule merge behavior.

## Risks & Open Decisions
- Recommendation: Use exactly the four values surfaced by Codex (`low`, `medium`, `high`, `xhigh`), with no `max`. Although the API documentation lists `max` for some models, it is model-dependent and not in the stated Codex UI range; the app-facing registry should not present a value outside that range.
- `none` is not offered in this consistent Codex-style selector because GPT-6 Astra rejects it; omitted values do not change proxy forwarding support for direct API requests.

## Verification Plan
- Run `npm test`.
- Confirm setup outputs all three GPT-6 canonical effort specs as `low/medium/high/xhigh` and legacy variants match.
- Confirm rerunning setup updates existing managed GPT model effort specs without dropping unrelated provider-model config.

## Execution Notes
- Implemented in `scripts/setup-provider.js`; tests added/updated in `test/setup-provider.test.js`.
- Canonical GPT model rules now register `low/medium/high/xhigh`. Setup refreshes those values on existing managed rules while preserving unrelated properties and option specs.
- Existing legacy GPT entries now refresh only the variants array; existing `defaultVariant` and custom fields remain unchanged.
- `npm test`: 75 passed, 0 failed. `git diff --check`: passed.
