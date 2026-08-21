# gpt-oauth

A ZCode plugin that provides ChatGPT (GPT Plus) OAuth login and a local OpenAI-compatible proxy so you can use GPT models in subagents **without an API key** (using your ChatGPT Plus subscription).

The plugin contains a single Node process (zero dependencies, Node >= 18) that runs both:

- an **MCP stdio server** (`gpt_login`, `gpt_logout`, `gpt_status` tools), and
- an **OpenAI-compatible HTTP proxy** on `http://127.0.0.1:8787/v1` that translates Chat Completions into the OpenAI Codex backend.

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

## Ports

| Port | Purpose |
|------|---------|
| `8787` | HTTP proxy (OpenAI-compatible Chat Completions). Binds loopback only. |
| `1455` | OAuth callback loopback server during login (falls back to a random port if busy). |

If port `8787` is already owned by another instance, the newer instance attempts a **version-aware takeover** (loopback handshake described below). If the existing instance is the same or newer, the second instance serves MCP only.

## Update mechanism

Updating the plugin (via **Settings → Plugin Management → update**, then restart ZCode) requires **no manual process killing**. When the updated server starts and finds an older instance already bound to port `8787`, it performs a safe handshake instead of erroring out:

1. The new process calls `GET /healthz` on the existing instance and reads its `version`.
2. If the existing version is **older**, it calls `POST /shutdown` with the `x-gpt-oauth-shutdown: 1` header (a CSRF-safe custom header that ordinary web forms cannot send — without it the endpoint returns `403`).
3. The old instance responds `{ok:true}` and exits itself (~300 ms).
4. The new process polls `/healthz` until the port frees, then binds `8787`. If the existing instance is the same/newer version (or unreachable), the new process serves MCP only.

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
- **Proxy not reachable**: ensure the plugin's MCP server is enabled and restart ZCode.
- **MCP "Reconnecting forever"**: the process now survives unexpected errors (logs to stderr, never exits). If you still see it, restart ZCode once so the new process starts.

## Verified working model ids

The proxy always advertises `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` in `/v1/models`, and all three work on this machine (each returned `200` with real generation). The legacy `gpt-5.x-codex*` ids are **not** supported when using Codex with a ChatGPT account (backend returns 400: "model is not supported when using Codex with a ChatGPT account"), so prefer the `gpt-5.6-*` family through this proxy.
