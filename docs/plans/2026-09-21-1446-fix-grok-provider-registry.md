# Implementation Plan: Register Grok Models in ZCode 3.14.1 Provider Registry

## Status
- Status: Completed
- Created: 2026-09-21 14:46
- Approved: Yes, 2026-09-21

## Execution Notes
- Delivered by two parallel workers with non-overlapping file scopes; no merge conflicts.
- New: `scripts/setup-provider.js` (651 lines) and `test/setup-provider.test.js` (470 lines).
- Modified: `commands/gpt-oauth/setup.md`, both marketplace catalogs, `.zcode-plugin/plugin.json`, `package.json`, `server/server.js`, `server/xai-oauth.js`, `README.md`.
- Integration gate: `npm test` → 68/68 pass, 0 fail.
- Version `0.3.1` verified consistent across all seven release-reference sites; no `0.3.0` remains.
- Helper verified end-to-end against a fixture home seeded from the live `~/.zcode/v2`: reused provider id `52fb78c2-e540-453b-b790-5d26a4e66f55`, kept `deepseek` and the four GPT rules, appended exactly the six Grok ids to `personalModelIds`/`modelOrder`, added six canonical `providerModelRules`, wrote a timestamped backup, reported no changes on the second run, and leaked no `apiKey`.
- Live user configuration was not modified; final validation is the manual plugin update and `/gpt-oauth:setup` run described below.
- Changes are uncommitted in the working tree (no commit was requested).

## Request Summary
Ship a fast plugin fix so `/gpt-oauth:setup` registers the six Grok models in the canonical ZCode 3.14.1 personal provider registry, while retaining the existing legacy configuration update for backward compatibility. Prepare version 0.3.1 for local marketplace update and user testing.

## Repository Findings & Exact References
- `commands/gpt-oauth/setup.md:17-53` only backs up and modifies `~/.zcode/v2/config.json` using the legacy `provider.<uuid>.models` shape.
- `~/.zcode/v2/provider_config.json:32-56` contains the active `gpt-oauth` provider rule, but `personalModelIds` and `modelOrder` contain only four GPT model IDs.
- `~/.zcode/v2/provider_config.json:60-109` has exact provider-model rules only for those GPT models.
- ZCode 3.14.1 runtime resolves the personal registry to `~/.zcode/v2/provider_config.json` and expects schema version 1 with `providerConfigRules` and `modelConfigRules`.
- The proxy already advertises and routes all six Grok IDs in `server/server.js:158-166` and `/v1/models`; proxy routing does not need modification.
- Package verification is `npm test` from `package.json:7`.
- Version references that must remain synchronized are `.zcode-plugin/plugin.json`, `.zcode-plugin/marketplace.json`, `marketplace.json`, `package.json`, `server/server.js`, `server/xai-oauth.js`, and `README.md`.

## Proposed Solution & Technical Contracts
Add a testable Node helper that performs idempotent, backup-first migration of both configuration formats. The canonical ZCode 3.14.1 contract is:

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "<stable provider UUID>",
          "providerName": "gpt-oauth",
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "local-proxy" },
            "api": {
              "type": "openai-chat-completions",
              "baseUrl": "http://127.0.0.1:8787/v1"
            },
            "personalModelIds": ["<all GPT and Grok model IDs>"],
            "modelOrder": ["<all GPT and Grok model IDs>"]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [
        {
          "providerId": "<stable provider UUID>",
          "modelId": "grok-4.6",
          "config": {
            "properties": {
              "contextWindow": 500000,
              "inputFormat": {
                "supportsText": true,
                "supportsImage": true,
                "supportsVideo": false,
                "supportsAudio": false,
                "supportsPdf": false
              }
            },
            "optionSpecs": {
              "reasoningLevel": { "values": ["low", "medium", "high", "xhigh"] },
              "maxOutputTokens": { "max": 128000 }
            }
          }
        }
      ]
    }
  }
}
```

Contracts:
- Reuse the existing provider UUID by provider name or the stored `~/.zcode/gpt-oauth/provider-uuid`; never create a second `gpt-oauth` provider when one exists.
- Preserve all unrelated providers, model rules, ordering, and unknown fields.
- Append only missing model IDs; do not duplicate or reorder existing entries.
- Upsert only the `gpt-oauth` rule for each known model ID.
- Create timestamped sibling backups before changing existing `config.json` or `provider_config.json`.
- Never print secrets; output only paths, provider ID, and added model IDs.
- Fail without partial writes when JSON is malformed or schema version is unsupported.
- Use atomic temp-file replacement for each generated JSON file.
- Keep legacy `config.json` registration for older ZCode releases.

Canonical Grok capability rules for the fast fix:
- `grok-4.6`: context 500000; text/image input; PDF/video/audio false; reasoning `low|medium|high|xhigh`; max output 128000.
- `grok-4.5`: context 500000; text/image input; PDF/video/audio false; reasoning `low|medium|high`; max output 128000.
- `grok-4.3`: context 1000000; text/image input; PDF/video/audio false; max output 128000; no reasoning override.
- `grok-build-0.1`: context 256000; text/image input; PDF/video/audio false; max output 128000; no reasoning override.
- `grok-4.20-0309-reasoning`: context 1000000; text/image input; PDF/video/audio false; max output 30000; no unverified reasoning variant list.
- `grok-4.20-0309-non-reasoning`: same limits/capabilities without reasoning options.

## Workstreams

### Workstream 1: Registry migration helper and tests
- Agent: worker
- Owned Files:
  - `scripts/setup-provider.js` (new)
  - `test/setup-provider.test.js` (new)
- Implementation Steps & Code Blueprint:
  1. Implement pure exported functions for loading, validating, merging, and serializing provider registries, plus a CLI entrypoint guarded by `require.main === module`.
  2. Accept `--home <path>` for isolated tests; default to `os.homedir()`.
  3. Merge canonical provider/model rules into `~/.zcode/v2/provider_config.json` and legacy entries into `~/.zcode/v2/config.json`.
  4. Write unit tests using temporary homes for:
     - fresh files;
     - existing provider with GPT-only registry;
     - repeated idempotent execution;
     - preservation of unrelated providers/rules/unknown fields;
     - malformed JSON and unsupported schema refusal;
     - backup creation;
     - absence of secret values in stdout/stderr.
- Verification: `node --test test/setup-provider.test.js`

### Workstream 2: Command, version, and marketplace synchronization
- Agent: worker
- Owned Files:
  - `commands/gpt-oauth/setup.md`
  - `.zcode-plugin/plugin.json`
  - `.zcode-plugin/marketplace.json`
  - `marketplace.json`
  - `package.json`
  - `server/server.js`
  - `server/xai-oauth.js`
  - `README.md`
- Implementation Steps & Code Blueprint:
  1. Replace the embedded legacy-only editing instructions in `setup.md` with platform-specific discovery of the installed plugin's `scripts/setup-provider.js` and execution through the available Node runtime.
  2. Keep login/proxy checks and explicit restart instructions.
  3. Document that setup updates both `provider_config.json` and legacy `config.json`, and that each existing file receives a timestamped backup.
  4. Bump plugin/package/server/user-agent/marketplace/README versions consistently from `0.3.0` to `0.3.1`.
  5. Preserve marketplace name `zcode-gpt-oauth`, plugin identity `gpt-oauth`, and source `./`.
- Verification:
  - JSON parse all manifest/catalog/package files.
  - `rg -n '0\.3\.0|0\.3\.1' README.md .zcode-plugin marketplace.json package.json server commands`

## Integration & Shared Work
- The parent agent will collect both worker results, confirm no overlapping edits beyond the approved scopes, and delegate corrections if integration checks fail.
- Run the full suite with `npm test`.
- Run the helper against a temporary HOME fixture and inspect only secret-redacted summaries.
- Do not automatically install/update the plugin cache. Per the plugin handoff contract, the user will refresh the existing local marketplace and click Update manually.
- After the user updates to 0.3.1, run `/gpt-oauth:setup`, fully restart ZCode, and verify `ListModels` shows the six Grok entries.

## Risks & Open Decisions
- Decision: whether to overwrite existing exact model-rule customizations.
  - Recommendation: preserve an existing rule unchanged and create rules only when absent. This minimizes surprise and keeps the migration idempotent; future versions can offer an explicit refresh option.
- Decision: whether to advertise PDF capability.
  - Recommendation: use `supportsPdf: false` to match ZCode 3.14.1's built-in Grok catalog and avoid claiming unsupported proxy behavior.
- Decision: whether to auto-edit the user's live registry during implementation.
  - Recommendation: do not. Ship and test the plugin update, then let the user update it through the existing local marketplace and run `/gpt-oauth:setup`; this verifies the real distribution path.

## Verification Plan
1. `node --test test/setup-provider.test.js`
2. `npm test`
3. Validate JSON syntax and synchronized version `0.3.1` across manifest, both marketplace catalogs, and package metadata.
4. Refresh the local market and manually update the plugin in ZCode.
5. In a new task, run `/gpt-oauth:setup`; expected result: setup reports Grok IDs added to `provider_config.json` and creates backups without exposing secrets.
6. Fully quit and reopen ZCode.
7. Verify the active registry exposes:
   - `grok-4.6`
   - `grok-4.5`
   - `grok-4.3`
   - `grok-build-0.1`
   - `grok-4.20-0309-reasoning`
   - `grok-4.20-0309-non-reasoning`
8. Run one text prompt on `grok-4.6` and one tool-call prompt; both should complete through the local proxy.
