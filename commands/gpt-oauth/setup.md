---
description: Register the gpt-oauth provider in ZCode model settings (GPT and Grok models) so subagents can use them without an API key.
---

# gpt-oauth: Setup

Register the `gpt-oauth` local proxy as an OpenAI-compatible provider in ZCode's model settings so GPT and Grok models can be used by subagents without an API key. The bundled setup helper writes the provider plus all eleven models (four GPT + seven Grok) into **both** the ZCode 3.14.1 provider registry (`~/.zcode/v2/provider_config.json`, schema v1 — this is what feeds the model picker) and the legacy `~/.zcode/v2/config.json`, then you restart ZCode.

Grok access requires an eligible Grok or X Premium subscription that includes API access; no `XAI_API_KEY` is needed.

> **Cross-platform:** this command works on macOS, Linux and Windows. Every shell-dependent step below gives **both** forms (bash for macOS/Linux, PowerShell for Windows). **Detect your platform first** so you pick the right commands.

## Step 0 — Detect your platform

- **macOS / Linux (Unix):** run `uname`. An output like `Darwin` (macOS) or `Linux` means use the **bash** commands below.
- **Windows:** run `$env:OS` in PowerShell. An output of `Windows_NT` means use the **PowerShell** commands below.

Conventions for the rest of this command: the Unix home `~` is `%USERPROFILE%` / `$env:USERPROFILE` on Windows, and `/` path separators become `\`.

## Step 1 — Check login state

1. Call the MCP tool `gpt-oauth` → `gpt_status`.
   - If `loggedIn` is false, tell the user to run `/gpt-oauth:login` first, and **STOP**.
2. Also call `xai_status` (advisory only, never blocking for GPT): if its `loggedIn` is false, tell the user that Grok models will not work until they run `/gpt-oauth:grok-login`. Continue with the setup regardless.

## Step 2 — Verify the proxy is reachable

**macOS / Linux:**
```bash
curl -s http://127.0.0.1:8787/v1/models
```

**Windows (PowerShell):**
```powershell
curl.exe -s http://127.0.0.1:8787/v1/models
```

If this fails, instruct the user to make sure the plugin's MCP server is enabled and to restart ZCode, then **STOP**.

## Step 3 — Locate the installed setup helper

The helper ships with the plugin and lives under the plugin cache. Prefer the newest installed release.

**macOS / Linux:**
```bash
HELPER=$(ls ~/.zcode/cli/plugins/cache/zcode-gpt-oauth/gpt-oauth/*/scripts/setup-provider.js 2>/dev/null | sort -V | tail -1)
echo "$HELPER"
```

**Windows (PowerShell):**
```powershell
$base = "$env:USERPROFILE\.zcode\cli\plugins\cache\zcode-gpt-oauth\gpt-oauth"
$latest = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
$HELPER = if ($latest) { Join-Path $latest.FullName 'scripts\setup-provider.js' } else { $null }
if ($HELPER -and -not (Test-Path $HELPER)) { $HELPER = $null }
$HELPER
```

The glob / directory listing covers any installed release (e.g. `gpt-oauth/0.3.3/scripts/setup-provider.js`); if multiple versions are installed, prefer the newest (sorted → last entry).

**If no helper is found** (empty `$HELPER`): the user has an outdated plugin — tell them to update the plugin (Settings → Plugin Management → update `gpt-oauth`, then restart ZCode) and **STOP**.

## Step 4 — Run the helper

The helper is a Node script. Run it with the Node runtime already required by this plugin's MCP server.

**macOS / Linux:**
```bash
node "$HELPER"
```

**Windows (PowerShell):**
```powershell
node $HELPER
```

- The helper creates a timestamped backup (`.bak-<timestamp>`) next to each configuration file that already exists **before** it writes anything, so the run is reversible.
- It is idempotent: an existing `gpt-oauth` provider and existing model entries are reused, and only missing models are added.
- If `node` is not found in `PATH`, tell the user a Node runtime (Node.js 18+) must be installed and available on `PATH`, then **STOP**.
- The helper targets the real user home by default. Only for unusual setups where the ZCode home is elsewhere, add `--home <path>`.
- Report only the paths, the provider id, and the added model ids that the helper prints. Never echo secrets.

## Step 5 — What the helper changes

- `~/.zcode/v2/provider_config.json` — the ZCode 3.14.1 personal provider registry (schema v1: `providerConfigRules` + `modelConfigRules`). This is the file ZCode 3.14.1 reads for the model picker, and it is why the seven Grok models now show up.
- `~/.zcode/v2/config.json` — the legacy provider shape, kept in sync so older ZCode releases keep working.
- `~/.zcode/gpt-oauth/provider-uuid` — the provider id (UUID) used for the `gpt-oauth` entry, so later runs and other commands find the same provider instead of creating a duplicate.
- A `.bak-<timestamp>` copy is created next to every file above that already existed (nothing is backed up for files created fresh by this run).

## Step 6 — Fully quit and restart ZCode

Tell the user: **quit ZCode completely (Cmd+Q on macOS) and reopen it** — the configuration is read only at startup. Closing the window or reloading a task is **not** enough, and editing config while the app runs risks the app overwriting it.

After the restart:
1. Settings → Model settings → provider `gpt-oauth` must list all **11** models — 4 GPT (`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) and 7 Grok (`grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-build-0.1`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`).
2. Settings → Subagents → pick the model for each subagent.

## Fallback (manual UI)

If the provider entry still does not appear, guide the user through the UI:
- Settings → Model settings → Add custom provider.
- Name: `gpt-oauth`
- Kind: OpenAI-compatible
- Base URL: `http://127.0.0.1:8787/v1`
- API key: `local-proxy`
- Add models: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-build-0.1`, `grok-4.20-0309-reasoning`, and `grok-4.20-0309-non-reasoning`.

## Rules

- **Never print raw tokens, secrets, or `apiKey` values.**
- When describing the configuration, only ever refer to the `gpt-oauth` provider and its model ids. Do not echo other providers' `apiKey` / `options` values.
- Do not delete or modify any `.bak-*` files.
- If a step fails, report exactly which step failed and stop; leave the backups in place so the user can roll back.
