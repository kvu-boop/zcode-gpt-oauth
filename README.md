# gpt-oauth

A ZCode plugin that provides ChatGPT (GPT Plus) OAuth login and a local OpenAI-compatible proxy so you can use GPT models in subagents **without an API key** (using your ChatGPT Plus subscription).

The plugin is a single Node codebase (zero dependencies, Node >= 18) running as two cooperating processes:

- an **MCP stdio server** per session (`gpt_login`, `gpt_logout`, `gpt_status` tools), and
- a **detached HTTP proxy daemon** on `http://127.0.0.1:8787/v1` that translates Chat Completions into the OpenAI Codex backend and survives MCP-session reaping (see [Architecture & update](#architecture--update)).

## Install

**From the marketplace (recommended):**

1. Open ZCode → **Settings → Plugin Management → Discover → +** → paste the GitHub URL `https://github.com/kvu-boop/zcode-gpt-oauth`.
2. The **gpt-oauth** plugin card appears → click **Get**.
3. Enable the plugin so its MCP server starts.

**Fallback — local directory install** (still works): Discover → + → choose **local directory** → select `~/zcode-plugins/gpt-oauth`. This is useful when running from a local checkout.

> Note on `.mcp.json`: we use the `"${pluginDir}/server/server.js"` interpolation form (the proven format used by the context7 plugin). If your ZCode version does not interpolate `${pluginDir}`, change the args to the relative path `"server/server.js"` since the plugin cache runs from the plugin root.

## Usage flow

1. `/gpt-oauth:login` — opens a browser tab for OAuth login to ChatGPT; waits up to 5 minutes. Verifies the proxy (`/healthz`, `/v1/models`) and reports email + expiry.
2. `/gpt-oauth:status` — shows login state, token expiry, proxy status and last error.
3. `/gpt-oauth:setup` — adds the `gpt-oauth` provider (baseURL `http://127.0.0.1:8787/v1`, API key `local-proxy`) to ZCode's model settings and registers the models `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, then instructs you to restart ZCode.
4. In **Settings → Model settings** the provider `gpt-oauth` appears; in **Settings → Subagents** pick any of the GPT models.

## Preset config

Since v0.2.0 the plugin bundles the author's personal ZCode config under `preset/` (`AGENTS.md` + subagent definitions under `preset/agents/`). Run

- `/gpt-oauth:setup-agents` — copies `preset/AGENTS.md` → `~/.zcode/AGENTS.md` and every `preset/agents/*.md` → `~/.zcode/agents/` (**worker**, **ui-expert**, **reviewer**, plus the plan **template**).

What it does:

1. Locates the `preset/` folder inside the installed plugin; if it is missing the plugin is outdated — update it first.
2. **Backs up** every file that will be overwritten before touching it: `~/.zcode/AGENTS.md` → `~/.zcode/AGENTS.md.bak-<timestamp>` and each existing `~/.zcode/agents/<name>.md` → `~/.zcode/agents/<name>.md.bak-<timestamp>`.
3. Copies the preset files into place, then **neutralizes model references**: any frontmatter line `model: "custom:<uuid>:<model>"` whose `<uuid>` is not one of *your* configured providers (checked against `~/.zcode/v2/config.json`) is commented out (`# `) so that subagent falls back to the default model. Lines pointing at providers you actually have are left unchanged.
4. Reports what was applied, the backup paths, and which files were neutralized.

**Roll back** (if you don't like the preset): restore the backups directly, e.g. `cp ~/.zcode/AGENTS.md.bak-<ts> ~/.zcode/AGENTS.md` (repeat for each `~/.zcode/agents/<name>.md.bak-<ts>`).

> After applying, open **Settings → Subagents** and pick the model for each subagent to match **your** providers (e.g. `gpt-5.6-*` models if you set up gpt-oauth with `/gpt-oauth:setup`). The command never reads or prints provider API keys.

## Ports

| Port | Purpose |
|------|---------|
| `8787` | HTTP proxy (OpenAI-compatible Chat Completions). Binds loopback only. |
| `1455` | OAuth callback loopback server during login (falls back to a random port if busy). |

## Architecture & update

Since v0.1.9 the HTTP proxy on port `8787` runs inside a **detached daemon process** (`server.js --daemon`), *not* inside the per-session MCP stdio process:

1. **The daemon owns the port independently of MCP sessions.** When ZCode reaps an idle session it kills the MCP stdio process, but the daemon is in its own process group (a new session), so port `8787` stays up. The next session finds the proxy already running — no slow "reconnect after idle".
2. **Any MCP-mode process auto-(re)spawns the daemon if it is missing.** On startup each MCP process calls `GET /healthz`; if the daemon is unreachable it spawns `node server.js --daemon` (detached, `stdio: ignore`, logs to `~/.zcode/gpt-oauth/daemon.log`, kept to the last ~1&nbsp;MB), then polls `/healthz` every 400&nbsp;ms for up to 20&nbsp;s before starting MCP stdio.
3. **Version takeover happens daemon-vs-daemon.** If the running daemon's `version` is **older** than the code, the new process calls `POST /shutdown` with the `x-gpt-oauth-shutdown: 1` header (a CSRF-safe custom header that ordinary web forms cannot send — without it the endpoint returns `403`), waits for the port to free, spawns its own daemon and takes over. Equal or newer → reuse.
4. `gpt_status` reports `proxyRunning` (daemon health) and, if the daemon cannot be brought up, `lastError` containing the last 5 lines of `daemon.log`.

Updating the plugin (via **Settings → Plugin Management → update**, then restart ZCode) requires **no manual process killing** — the recommended flow is unchanged: start the updated version, let it take over from any older instance via the handshake above, and let the daemon re-spawn from the current code.

`/gpt-oauth:status` (`gpt_status`) also reports `latestVersion` and `updateAvailable` (checked against the marketplace, cached for an hour), so you can see when a new release is available.

## Image input

The proxy accepts **both text and image input**. In Chat Completions, `user` message parts with `{"type":"image_url","image_url":{"url": ...}}` are forwarded as `input_image`. `data:image/...;base64,...` URLs pass through unchanged and `http(s)` URLs are passed through for the backend to validate. The model entries this plugin registers advertise `modalities.input: ["text", "image"]`.

## Token storage

Tokens are stored at `~/.zcode/gpt-oauth/auth.json`:

```json
{ "access": "...", "refresh": "...", "expires": 0, "accountId": "...", "email": "...", "savedAt": 0 }
```

- Written atomically (tmp file + rename), dir auto-created.
- On first need, if the store is missing/expired, the server imports the existing `openai` OAuth entry from `~/.local/share/opencode/auth.json` (read-only; never modified).
- Tokens are never logged.

### Windows

Windows requires Node.js to be available in `PATH`. The plugin opens the default browser via `rundll32 url.dll,FileProtocolHandler` (avoiding `cmd.exe` ampersand query parsing), with `explorer` as a fallback. If the browser does not open, the login result includes the authorize URL so you can open it manually. Tokens are stored at `%USERPROFILE%\.zcode\gpt-oauth\auth.json`.

## Security notes

- The OAuth **access/refresh tokens are stored in plaintext** on disk in your home directory (0600 permissions). Anyone with access to your account can use your ChatGPT subscription.
- Using ChatGPT Plus via the Codex backend through this proxy is a **terms-of-service grey area** — you acknowledge this risk by using the plugin.
- The proxy binds to loopback only (`127.0.0.1`).

## Troubleshooting

### Known limitation: streaming is buffered

Streaming responses (`stream: true`) are emitted after the upstream model completes, **not token-by-token**. The proxy aggregates the backend SSE then re-emits standardized `chat.completion.chunk` events, so you get the same structured chunks but no incremental token streaming.

### Other issues

- **Model 404 ("model not found on backend")**: the backend may not serve the advertised model. Edit the model list in **Settings → Model settings** for the `gpt-oauth` provider (add one of the working ids from below, or the ones the backend reports).
- **401 "re-login required"**: run `/gpt-oauth:login` again to re-authenticate.
- **Proxy not reachable**: any MCP-mode process auto-spawns the daemon on startup, so usually just using the plugin restores it. If it is still down, check the last lines of `~/.zcode/gpt-oauth/daemon.log` and ensure the plugin's MCP server is enabled, then restart ZCode.
- **MCP "Reconnecting forever"**: the process now survives unexpected errors (logs to stderr, never exits). If you still see it, restart ZCode once so the new process starts.

## Verified working model ids

The proxy always advertises `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` in `/v1/models`, and all three work on this machine (each returned `200` with real generation). The legacy `gpt-5.x-codex*` ids are **not** supported when using Codex with a ChatGPT account (backend returns 400: "model is not supported when using Codex with a ChatGPT account"), so prefer the `gpt-5.6-*` family through this proxy.
