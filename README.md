# gpt-oauth

A ZCode plugin that lets you use GPT models with your **ChatGPT Plus subscription** and Grok models with an eligible **Grok or X Premium subscription that includes Grok API access**. It handles browser/device OAuth login and runs a local OpenAI-compatible proxy at `http://127.0.0.1:8787/v1`. No `XAI_API_KEY` is needed; access is granted by the xAI subscription OAuth flow.

## Quick usage

1. Install the plugin from the ZCode marketplace (**Settings → Plugin Management → Discover → +** → paste `https://github.com/kvu-boop/zcode-gpt-oauth` → **Get** → enable it).
2. Run the initial commands below, in this order:

| Command | What it does |
|---------|--------------|
| `/gpt-oauth:login` | Opens a browser for ChatGPT OAuth login (waits up to 5 min). |
| `/gpt-oauth:grok-login` | Opens the xAI device verification flow for Grok OAuth. |
| `/gpt-oauth:grok-logout` | Removes only the stored xAI/Grok OAuth credentials. |
| `/gpt-oauth:setup` | Registers the `gpt-oauth` provider + GPT and Grok text/tool models, then restart ZCode. |
| `/gpt-oauth:status` | Shows ChatGPT and xAI login state, token expiry, proxy status, and update info. |

3. In **Settings → Subagents**, pick any of the GPT or Grok models and you're done.

Optional: `/gpt-oauth:cache-miss-on` / `cache-miss-off` toggle cache-miss notices; `/gpt-oauth:setup-agents` applies the bundled agent preset.

## Version

Current version: **v0.3.2** — fixes Grok (xAI) streaming by removing the 5-second upstream-silence abort that killed long reasoning turns mid-stream with `Turn execution failed ... reason=unknown retryable=false`. Grok image/video generation is not supported. Run `/gpt-oauth:status` to check `latestVersion` and `updateAvailable`.

Thanks for stopping by and using this plugin!
