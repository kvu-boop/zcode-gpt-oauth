---
description: Add or update the gpt-oauth provider in ZCode model settings and enable GPT models for subagents.
---

# gpt-oauth: Setup

Register the gpt-oauth local proxy as an OpenAI-compatible provider in ZCode's model settings so GPT models can be used by subagents without an API key.

## Steps

1. Call the MCP tool `gpt-oauth` → `gpt_status`.
   - If `loggedIn` is false, tell the user to run `/gpt-oauth:login` first, and STOP.

2. Verify the proxy is reachable: `curl -s http://127.0.0.1:8787/v1/models`.
   - If this fails, instruct the user to make sure the plugin's MCP server is enabled and restart ZCode, then STOP.

3. Back up the config: `cp ~/.zcode/v2/config.json ~/.zcode/v2/config.json.bak-$(date +%Y%m%d%H%M%S)`

4. Read `~/.zcode/v2/config.json` (use `cat` or read it) and locate the `provider` object.
   - **If `~/.zcode/v2/config.json` does not exist** (or has no top-level `provider` key): first create it with a minimal structure before editing, e.g. via python3 writing `{"provider": {}}` (preserving anything already present).
   - **Important:** when reading/reporting the config, do NOT echo other providers' `apiKey` / `options` values — only ever surface the `gpt-oauth` entry and model ids. Redact any secrets.
   - If a provider entry with `name == "gpt-oauth"` already exists, reuse its key. Only add any missing models to its `models` object (idempotent; do not duplicate existing models).
   - Otherwise generate a new id with `uuidgen` and insert this entry into `provider`:

```json
"<uuid>": {
  "name": "gpt-oauth",
  "kind": "openai-compatible",
  "options": {
    "apiKey": "local-proxy",
    "baseURL": "http://127.0.0.1:8787/v1",
    "apiKeyRequired": true
  },
  "source": "custom",
  "models": {
    "gpt-5.6-sol":  { "limit": { "context": 256000, "output": 128000 }, "modalities": { "input": ["text"], "output": ["text"] } },
    "gpt-5.6-terra":{ "limit": { "context": 256000, "output": 128000 }, "modalities": { "input": ["text"], "output": ["text"] } },
    "gpt-5.6-luna": { "limit": { "context": 256000, "output": 128000 }, "modalities": { "input": ["text"], "output": ["text"] } }
  }
}
```

   - Use **python3** to edit the JSON so all other keys are preserved (load JSON — or start from `{"provider": {}}` if the file is missing — modify the `provider` dict, dump back with `indent=2`).
   - Save the chosen uuid to `~/.zcode/gpt-oauth/provider-uuid` (the provider key/id).

5. Tell the user: **RESTART ZCode now** — the config file is read at startup. If ZCode is not restarted, it may overwrite the file and lose the entry.
   - After restart: Settings → Model settings → provider "gpt-oauth" should be visible → edit models freely → Settings → Subagents → pick a model for any subagent.

## Fallback (manual UI)

If the provider entry disappears because the app overwrote `config.json`, guide the user through the UI:
- Settings → Model settings → Add custom provider.
- Name: `gpt-oauth`
- Kind: OpenAI-compatible
- Base URL: `http://127.0.0.1:8787/v1`
- API key: `local-proxy`
- Add models: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.

Do not print raw tokens or secrets.
