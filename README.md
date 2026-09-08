# gpt-oauth

A ZCode plugin that lets you use GPT models with your **ChatGPT Plus subscription** — no API key needed. It handles OAuth login and runs a local OpenAI-compatible proxy at `http://127.0.0.1:8787/v1`.

## Quick usage

1. Install the plugin from the ZCode marketplace (**Settings → Plugin Management → Discover → +** → paste `https://github.com/kvu-boop/zcode-gpt-oauth` → **Get** → enable it).
2. Run the initial commands below, in this order:

| Command | What it does |
|---------|--------------|
| `/gpt-oauth:login` | Opens a browser for ChatGPT OAuth login (waits up to 5 min). |
| `/gpt-oauth:setup` | Registers the `gpt-oauth` provider + models (`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`), then restart ZCode. |
| `/gpt-oauth:status` | Shows login state, token expiry, proxy status, and update info. |

3. In **Settings → Subagents**, pick any of the GPT models and you're done.

Optional: `/gpt-oauth:cache-miss-on` / `cache-miss-off` toggle cache-miss notices; `/gpt-oauth:setup-agents` applies the bundled agent preset.

## Version

Current version: **v0.2.8** — adds the GPT-6 Astra model and reasoning-effort forwarding (Light / Medium / High / Extra High / Max). Run `/gpt-oauth:status` to check `latestVersion` and `updateAvailable`.

Thanks for stopping by and using this plugin!
