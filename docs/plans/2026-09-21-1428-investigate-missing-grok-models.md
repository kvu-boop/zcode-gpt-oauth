# Investigate Missing Grok Models

Status: Completed

## Objective

Determine why Grok models present in `~/.zcode/v2/config.json` and exposed by the local OAuth proxy do not appear in ZCode's active model registry or settings UI.

## Scope

Read-only investigation. No application configuration, plugin source, credentials, processes, or runtime state will be modified.

## Parallel Investigation

1. **Configuration loading explorer**
   - Trace which files ZCode 3.14.1 reads for custom model providers.
   - Compare `~/.zcode/v2/config.json`, `~/.zcode/v2/provider_config.json`, `~/.zcode/v2/setting.json`, and relevant application storage.
   - Identify any generated cache or allowlist that controls visible models.

2. **Runtime log explorer**
   - Inspect recent ZCode logs around application startup and model registry initialization.
   - Search for provider `52fb78c2-e540-453b-b790-5d26a4e66f55`, `gpt-oauth`, Grok model IDs, validation failures, filtering, or stale cache behavior.

3. **Schema compatibility explorer**
   - Compare Grok definitions in `commands/gpt-oauth/setup.md` and the active config against current ZCode schemas and known-working model definitions.
   - Check whether modality values, reasoning variants, limits, or missing metadata cause entries to be rejected.

## Integration

- Correlate config source, timestamps, logs, and schema findings.
- Report the evidence-backed root cause and the smallest safe remediation.
- Do not apply remediation until explicitly requested.

## Findings

- ZCode 3.14.1 resolves the personal provider registry to `~/.zcode/v2/provider_config.json`.
- The `gpt-oauth` provider rule in that registry contains only the four GPT model IDs in `personalModelIds`, `modelOrder`, and exact provider-model rules.
- The six Grok entries were written only to the legacy `~/.zcode/v2/config.json` provider map, whose `reasoning` / `limit` / `modalities` model shape is not the current personal provider registry schema.
- The local proxy correctly advertises all ten GPT and Grok model IDs, so authentication and proxy inventory are not the cause.
- The active `ListModels` registry exposes exactly the four GPT models listed in `provider_config.json`, confirming the missing registry entries are the direct cause.
- No log evidence shows Grok entries being rejected for dotted IDs, context limits, missing `defaultVariant`, or reasoning variant values. Those legacy fields are not what the current registry parser consumes.

## Recommended Remediation

Update the plugin setup command to register Grok models in `~/.zcode/v2/provider_config.json` using schema version 1, including `personalModelIds`, `modelOrder`, and exact provider-model rules in the canonical ZCode 3.14.1 format. Preserve all existing provider and model rules and retain the legacy `config.json` update only if backward compatibility is required.

## Verification

- Confirm findings against the active model list via `ListModels`.
- Confirm proxy inventory through `GET http://127.0.0.1:8787/v1/models`.
