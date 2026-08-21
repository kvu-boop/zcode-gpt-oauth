#!/usr/bin/env node
/*
 * gpt-oauth — ZCode plugin MCP server.
 *
 * Single Node process, zero runtime dependencies.
 *  - OAuth login to ChatGPT (PKCE, like opencode/Codex CLI)
 *  - OpenAI-compatible HTTP proxy on 127.0.0.1:8787 -> OpenAI Codex backend
 *  - MCP stdio (JSON-RPC 2.0, newline-delimited JSON)
 *
 * IMPORTANT: only JSON-RPC protocol traffic goes to stdout. ALL logging goes
 * to stderr. Tokens are NEVER logged.
 *
 * CLI flags:
 *   --http-only   run proxy only (skip MCP stdio)   [used for curl tests]
 *   --mcp-only    run MCP stdio only (skip HTTP)
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');

const VERSION = '0.1.7';
const NAME = 'gpt-oauth';

// ---------------------------------------------------------------------------
// Config / paths
// ---------------------------------------------------------------------------
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE = 'https://auth.openai.com/oauth';
const BACKEND_BASE = 'https://chatgpt.com/backend-api/codex';

// OAuth flow matching the Codex CLI (opencode-openai-codex-auth).
const REDIRECT_PATH = '/auth/callback';
const REDIRECT_HOST = 'localhost';
const SCOPE = 'openid profile email offline_access';

const ZCODE_DIR = path.join(os.homedir(), '.zcode');
const TOKEN_DIR = path.join(ZCODE_DIR, 'gpt-oauth');
const TOKEN_FILE = path.join(TOKEN_DIR, 'auth.json');
const OPENCODE_AUTH = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 8787;
const FALLBACK_PORT = 8788;
const OAUTH_PORT = 1455;
const OAUTH_MAX_WAIT_MS = 5 * 60 * 1000;

const MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const MODEL_OWNED_BY = 'chatgpt-oauth';

// Which parts of the server run.
const args = process.argv.slice(2);
const HTTP_ONLY = args.includes('--http-only');
const MCP_ONLY = args.includes('--mcp-only');
const RUN_MCP = !HTTP_ONLY;
const RUN_HTTP = !MCP_ONLY;

// ---------------------------------------------------------------------------
// Logging (stderr only)
// ---------------------------------------------------------------------------
function log(...a) { process.stderr.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`); }
function errlog(...a) { process.stderr.write(`[ERR ${new Date().toISOString()}] ${a.join(' ')}\n`); }

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------
function loadStore() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveStore(store) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  const tmp = TOKEN_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
  fs.chmodSync(TOKEN_FILE, 0o600);
}

function clearStore() {
  try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Bootstrap import from opencode auth.json (READ-ONLY on that file)
// ---------------------------------------------------------------------------
function bootstrapFromOpencode() {
  let raw;
  try { raw = fs.readFileSync(OPENCODE_AUTH, 'utf8'); } catch (e) { return false; }
  let data;
  try { data = JSON.parse(raw); } catch (e) { return false; }
  if (!data || typeof data !== 'object') return false;
  const entry = data.openai || data['openai'];
  if (!entry || entry.type !== 'oauth') return false;
  const refresh = entry.refresh;
  const access = entry.access;
  const expires = entry.expires;
  if (!refresh || !expires) return false;
  // Only import if the access token is still valid (expires in the future).
  if (typeof expires === 'number' && expires > Date.now()) {
    saveStore({
      access: String(access || ''),
      refresh: String(refresh),
      expires: expires,
      accountId: entry.accountId ? String(entry.accountId) : null,
      email: entry.email ? String(entry.email) : null,
      savedAt: Date.now(),
    });
    log('Bootstrap: imported openai oauth entry from opencode auth.json');
    return true;
  }
  return false;
}

// Ensure a valid store exists: load it, otherwise try bootstrap.
// Returns the store or null if no valid token available.
function ensureStore() {
  let store = loadStore();
  if (store && store.refresh && (store.expires > Date.now() + 60 * 1000)) {
    return store;
  }
  // Store missing/expired: try bootstrap import.
  if (bootstrapFromOpencode()) {
    store = loadStore();
    if (store && store.refresh) return store;
  }
  return store && store.refresh ? store : null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
// Pick the correct driver (http/https) based on the URL protocol.
function driverFor(u) {
  return u.protocol === 'https:' ? https : http;
}

function getJSON(url, headers, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = driverFor(u);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: headers || {},
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { resolve({ status: res.statusCode, body }); });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = driverFor(u);
    const body = new URLSearchParams(form).toString();
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { resolve({ status: res.statusCode, body: b }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    req.write(body);
    req.end();
  });
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Refresh token
// ---------------------------------------------------------------------------
let refreshPromise = null;   // in-flight refresh, for dedupe across concurrent requests
let refreshFailedCount = 0;  // consecutive refresh failures; store cleared only after threshold
const REFRESH_FAIL_THRESHOLD = 3;

async function refreshAccess(store) {
  // Serialize concurrent refreshes: if one is already in flight, await it.
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const res = await postForm(`${AUTH_BASE}/token`, {
      grant_type: 'refresh_token',
      refresh_token: store.refresh,
      client_id: CLIENT_ID,
    });
    if (res.status < 200 || res.status >= 300) {
      // A single 4xx (e.g. rotated-token race) must NOT wipe a valid store.
      refreshFailedCount++;
      if (refreshFailedCount >= REFRESH_FAIL_THRESHOLD) {
        clearStore();
      }
      const msg = 're-login required (refresh failed ' + refreshFailedCount + '/' + REFRESH_FAIL_THRESHOLD + ' with status ' + res.status + ')';
      const e = new Error(msg);
      e.refreshFailed = true;
      e.upstreamStatus = 401;
      throw e;
    }
    refreshFailedCount = 0;
    let data;
    try { data = JSON.parse(res.body); } catch (e) { throw new Error('bad refresh response'); }
    const newAccess = data.access_token || data.access;
    const newRefresh = data.refresh_token || data.refresh || store.refresh;
    if (!newAccess) throw new Error('refresh response missing access_token');
    const expires = data.expires_in ? Date.now() + data.expires_in * 1000 : (store.expires || 0);
    store.access = newAccess;
    store.refresh = newRefresh; // rotation: persist the NEW refresh token
    store.expires = expires;
    store.savedAt = Date.now();
    saveStore(store);
    log('Refreshed access token (new expiry ' + new Date(expires).toISOString() + ')');
    return store;
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

// Get a valid access token, refreshing if needed. Throws if none available.
async function getAccess() {
  let store = ensureStore();
  if (!store) {
    const e = new Error('not logged in — run /gpt-oauth:login first');
    e.code = 'NOT_LOGGED_IN';
    e.upstreamStatus = 401;
    throw e;
  }
  if (store.expires <= Date.now() + 60 * 1000) {
    store = await refreshAccess(store);
  }
  return store;
}

// ---------------------------------------------------------------------------
// Account id + email resolution
// ---------------------------------------------------------------------------
// Decode the id_token JWT payload -> { email, accountId }.
// accountId comes from payload["https://api.openai.com/auth"].chatgpt_account_id.
function decodeIdToken(idToken) {
  const out = { email: null, accountId: null };
  if (!idToken) return out;
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return out;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload && typeof payload.email === 'string') out.email = payload.email;
    if (payload && payload['https://api.openai.com/auth'] && payload['https://api.openai.com/auth'].chatgpt_account_id) {
      out.accountId = String(payload['https://api.openai.com/auth'].chatgpt_account_id);
    }
  } catch (e) { /* ignore */ }
  return out;
}

async function resolveAccount(store) {
  let res;
  try {
    res = await getJSON(`${BACKEND_BASE}/accounts`, {
      'Authorization': 'Bearer ' + store.access,
    });
  } catch (e) {
    throw new Error('accounts call failed: ' + e.message);
  }
  if (res.status < 200 || res.status >= 300) {
    // Imported/legacy tokens may not support this endpoint; keep tokens.
    log('accounts call returned status ' + res.status + ' (keeping tokens, accountId=null)');
    store.accountId = null;
    saveStore(store);
    throw new Error('accounts call failed with status ' + res.status + ': ' + res.body.slice(0, 200));
  }
  let data;
  try { data = JSON.parse(res.body); } catch (e) { throw new Error('accounts response not JSON: ' + res.body.slice(0, 200)); }

  // Defensive parse: shape may be {items:[...]} or a plain array.
  const items = Array.isArray(data) ? data : (data.items || data.data || data.accounts || []);
  const isChatgpt = (acc) => {
    if (!acc) return false;
    const t = String(acc.type || acc.account_type || acc.kind || (acc.account && acc.account.type) || '');
    if (/chatgpt|plus|free/i.test(t + (acc.plan || ''))) return true;
    // Heuristic: ChatGPT-plan accounts typically have billing/subscription info.
    return acc.plan_type !== 'api' && acc.account_type !== 'api' && acc.subscription !== undefined;
  };
  let chosen = null;
  for (const it of items) {
    const acc = it.account || it;
    if (isChatgpt(acc)) { chosen = acc; break; }
  }
  if (!chosen && items && items.length) chosen = items[0].account || items[0];
  if (chosen) {
    // account.account_id / account_id
    const aid = chosen.account_id || (chosen.account && chosen.account.account_id);
    if (aid) store.accountId = String(aid);
  }
  if (!store.accountId) store.accountId = null;
  saveStore(store);
  return store;
}

// ---------------------------------------------------------------------------
// OAuth login (PKCE, loopback)
// ---------------------------------------------------------------------------
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // Pass the URL directly to Windows handlers; cmd.exe would re-parse '&'
      // query separators as command delimiters and truncate the authorize URL.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' }).on('error', () => {
        spawn('explorer', [url], { stdio: 'ignore' }).on('error', () => {
          errlog('Could not open browser. Open this URL manually: ' + url);
        });
      });
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore' }).on('error', () => {});
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore' }).on('error', () => {});
    }
  } catch {}
}

async function oauthLogin() {
  // Build code verifier / challenge.
  const codeVerifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));

  // Find an available loopback port starting at OAUTH_PORT.
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function tryListen(port) {
      const server = http.createServer();
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempts < 20) {
          attempts++;
          const nextPort = 1455 + attempts;
          log('OAuth port ' + port + ' busy, trying ' + nextPort);
          tryListen(nextPort);
        } else {
          reject(new Error('could not bind OAuth callback: ' + e.message));
        }
      });
      server.listen(port, '127.0.0.1', () => {
        log('OAuth callback listening on http://localhost:' + port + REDIRECT_PATH);
        startFlow(server, port);
      });
    }

    async function startFlow(server, port) {
      const redirectUri = `http://${REDIRECT_HOST}:${port}${REDIRECT_PATH}`;
      const authorizeUrl = `${AUTH_BASE}/authorize?` + new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPE,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state: state,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'codex_cli_rs',
      });

      let code = null;
      let gotState = null;
      const timeout = setTimeout(() => {
        try { server.close(); } catch (e) {}
        const timeoutError = new Error('OAuth login timed out after 5 minutes');
        timeoutError.manualUrl = authorizeUrl;
        reject(timeoutError);
      }, OAUTH_MAX_WAIT_MS);

      server.on('request', (req, res) => {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname !== REDIRECT_PATH) {
          res.writeHead(404); res.end('not found'); return;
        }
        gotState = u.searchParams.get('state');
        code = u.searchParams.get('code');
        // Validate code/state BEFORE sending the success page.
        if (!code || gotState !== state) {
          clearTimeout(timeout);
          try { server.close(); } catch (e) {}
          const failHtml = '<!doctype html><html><body style="font-family:sans-serif;text-align:center;margin-top:100px"><h2>Login Failed</h2><p>Invalid or mismatched OAuth callback (code/state). Please try again.</p></body></html>';
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(failHtml);
          const callbackError = new Error('OAuth callback code/state mismatch (possible CSRF)');
          callbackError.manualUrl = authorizeUrl;
          reject(callbackError);
          return;
        }
        const html = '<!doctype html><html><body style="font-family:sans-serif;text-align:center;margin-top:100px"><h2>Login OK</h2><p>You can close this tab and return to ZCode.</p></body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        clearTimeout(timeout);
        try { server.close(); } catch (e) {}
        (async () => {
          try {
            const token = await postForm(`${AUTH_BASE}/token`, {
              grant_type: 'authorization_code',
              code: code,
              code_verifier: codeVerifier,
              client_id: CLIENT_ID,
              redirect_uri: redirectUri,
            });
            if (token.status < 200 || token.status >= 300) {
              const tokenError = new Error('token exchange failed with status ' + token.status + ': ' + token.body.slice(0, 200));
              tokenError.manualUrl = authorizeUrl;
              reject(tokenError);
              return;
            }
            const t = JSON.parse(token.body);
            const idTokenInfo = decodeIdToken(t.id_token);
            const store = {
              access: t.access_token,
              refresh: t.refresh_token,
              expires: Date.now() + (t.expires_in ? t.expires_in * 1000 : 0),
              accountId: idTokenInfo.accountId,
              email: idTokenInfo.email,
              savedAt: Date.now(),
            };
            saveStore(store);
            // Fall back to the codex accounts endpoint if id_token lacked accountId.
            let accountErr = null;
            if (!store.accountId) {
              try { await resolveAccount(store); } catch (e) { accountErr = e.message; }
            } else {
              log('Resolved accountId from id_token (chatgpt_account_id)');
            }
            const final = loadStore();
            resolve({ email: final.email, accountId: final.accountId, expires: final.expires, accountError: accountErr });
          } catch (e) {
            if (!e.manualUrl) e.manualUrl = authorizeUrl;
            reject(e);
          }
        })();
      });

      openBrowser(authorizeUrl);
    }

    tryListen(OAUTH_PORT);
  });
}

// ---------------------------------------------------------------------------
// MCP stdio (JSON-RPC 2.0, newline-delimited JSON)
// ---------------------------------------------------------------------------
function mcpResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function mcpError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function handleTool(name, params) {
  params = params || {};
  switch (name) {
    case 'gpt_login': {
      try {
        const r = await oauthLogin();
        return mcpResult({
          ok: true,
          email: r.email,
          accountId: r.accountId,
          expires: r.expires,
          accountError: r.accountError || null,
        });
      } catch (e) {
        const manual = e.manualUrl ? ` Open this URL manually: ${e.manualUrl}` : '';
        return mcpError('gpt_login failed: ' + e.message + manual);
      }
    }
    case 'gpt_logout': {
      const existed = !!loadStore();
      clearStore();
      return mcpResult({ ok: true, wasLoggedIn: existed });
    }
    case 'gpt_status': {
      const store = loadStore();
      let proxyRunning = false;
      try {
        const h = await getJSON(`http://${PROXY_HOST}:${PROXY_PORT}/healthz`, {}, 2000);
        proxyRunning = h.status === 200;
      } catch (e) { proxyRunning = false; }
      const lastError = global.lastError || null;
      if (!store) {
        return mcpResult({
          loggedIn: false, email: null, accountId: null, expires: null,
          accessValid: false, proxyRunning, lastError,
        });
      }
      return mcpResult({
        loggedIn: true,
        email: store.email || null,
        accountId: store.accountId || null,
        expires: store.expires,
        accessValid: store.expires > Date.now(),
        proxyRunning,
        lastError,
      });
    }
    default:
      return null; // unknown tool
  }
}

function startMCP() {
  log('Starting MCP stdio (gpt-oauth v' + VERSION + ')');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }

    const send = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: VERSION },
        },
      });
      return;
    }
    // notifications: method starts with "notifications/" or has no id
    if (msg.method && (msg.method.startsWith('notifications/') || msg.id === undefined)) {
      return; // ignore notifications
    }
    if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          tools: [
            {
              name: 'gpt_login',
              description: 'Open browser to log in to ChatGPT (GPT Plus) via OAuth. Waits up to 5 minutes. Returns {email, accountId, expires}.',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
            {
              name: 'gpt_logout',
              description: 'Delete the stored OAuth token (forces re-login).',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
            {
              name: 'gpt_status',
              description: 'Return login status, token expiry, proxy status and last error.',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
          ],
        },
      });
      return;
    }
    if (msg.method === 'tools/call') {
      const t = msg.params && msg.params.name;
      const p = msg.params && msg.params.arguments;
      handleTool(t, p).then((res) => {
        if (res === null) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool: ' + t } });
        } else {
          send({ jsonrpc: '2.0', id: msg.id, result: res });
        }
      }).catch((e) => {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
      });
      return;
    }
    // Unknown method
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  });
}

// ---------------------------------------------------------------------------
// HTTP proxy -> Codex backend
// ---------------------------------------------------------------------------
function buildBackendBody(body) {
  const instructions = [];
  const input = [];
  const tools = [];

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    const role = m.role;
    const content = m.content;

    if (role === 'system' || role === 'developer') {
      const txt = Array.isArray(content) ? content.map((c) => (c && c.type === 'text' ? c.text : '')).join('\n') : String(content || '');
      if (txt) instructions.push(txt);
      continue;
    }
    if (role === 'user') {
      if (Array.isArray(content)) {
        const hasImage = content.some((c) => c && (c.type === 'image_url' || c.type === 'image'));
        if (hasImage) {
          const e = new Error('image input not supported');
          e.code = 400;
          throw e;
        }
        const txt = content.map((c) => (c && c.type === 'text' ? c.text : '')).join('\n');
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: txt }] });
      } else {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: String(content || '') }] });
      }
      continue;
    }
    if (role === 'assistant') {
      const txt = Array.isArray(content) ? content.map((c) => (c && c.type === 'text' ? c.text : '')).join('') : String(content || '');
      if (txt) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: txt }] });
      }
      // Tool calls are top-level input items (not nested inside a message's
      // content) in the backend Responses API.
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          input.push({
            type: 'function_call',
            name: fn.name,
            arguments: fn.arguments || '{}',
            call_id: tc.id,
          });
        }
      }
      continue;
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof content === 'string' ? content : JSON.stringify(content),
      });
      continue;
    }
    // Unknown role: pass text through if string.
    if (typeof content === 'string') {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] });
    }
  }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      const fn = (t && t.function) || t || {};
      tools.push({
        type: 'function',
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object' },
        strict: false,
      });
    }
  }

  return {
    model: body.model,
    instructions: instructions.length ? instructions.join('\n\n') : undefined,
    input: input,
    tools: tools.length ? tools : undefined,
    stream: true,
    store: false,
  };
}

// Parse the SSE body into events (list of parsed JSON objects with a data field).
function parseSSE(body) {
  const events = [];
  // Normalize line endings, then split into event blocks on blank lines.
  const blocks = String(body).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
  for (const block of blocks) {
    // Multi-line `data:` fields are concatenated with '\n' per the SSE spec.
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    const dataLine = dataLines.join('\n').trim();
    if (dataLine && dataLine !== '[DONE]') {
      try { events.push(JSON.parse(dataLine)); } catch (e) { /* skip non-JSON */ }
    }
  }
  return events;
}

function postBackend(store, body, retry = true) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BACKEND_BASE}/responses`);
    const json = JSON.stringify(body);
    const headers = {
      'Authorization': 'Bearer ' + store.access,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'User-Agent': 'codex_cli_rs/0.42.0 (macOS 15.2; arm64)',
      'originator': 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
    };
    if (store.accountId) headers['chatgpt-account-id'] = store.accountId;
    const mod = driverFor(u);
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers,
      timeout: 120000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode === 401 && retry) {
          // refresh once and retry
          refreshAccess(store).then(() => {
            postBackend(loadStore(), body, false).then(resolve).catch(reject);
          }).catch((e) => reject(e));
          return;
        }
        resolve({ status: res.statusCode, body: buf });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    req.write(json);
    req.end();
  });
}

// Transform a chat.completions request into codex response events / final obj.
async function doChatCompletion(clientBody) {
  const store = await getAccess();
  const backendBody = buildBackendBody(clientBody);

  const res = await postBackend(store, backendBody);

  if (res.status === 401) {
    // Second failure after refresh -> 401 to client.
    const e = new Error('re-login required');
    e.upstreamStatus = 401;
    throw e;
  }
  if (res.status === 404) {
    const e = new Error('model not found on backend');
    e.upstreamStatus = 404;
    e.upstreamBody = res.body.slice(0, 300);
    throw e;
  }
  if (res.status < 200 || res.status >= 300) {
    const e = new Error('backend error ' + res.status + ': ' + res.body.slice(0, 300));
    e.upstreamStatus = res.status;
    throw e;
  }

  const events = parseSSE(res.body);
  return transformEvents(events, clientBody);
}

function transformEvents(events, clientBody) {
  let text = '';
  const toolCalls = []; // {id,name,arguments}
  let usage = null;
  let hasError = null;

  for (const ev of events) {
    const type = ev.type;
    if (type === 'response.output_text.delta') {
      if (ev.delta) text += ev.delta;
    } else if (type === 'response.output_item.done') {
      const item = ev.item;
      if (item && item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : (item.arguments ? JSON.stringify(item.arguments) : '{}'),
        });
      }
    } else if (type === 'response.completed') {
      const r = ev.response;
      if (r && r.usage) usage = r.usage;
    } else if (type === 'response.failed' || type === 'error' || type === 'response.error') {
      hasError = (ev.message) || (ev.error && ev.error.message) || 'backend error';
      if (ev.code) hasError = ev.code + ': ' + hasError;
    }
  }
  if (hasError) {
    const e = new Error(String(hasError));
    e.upstreamStatus = 502;
    throw e;
  }

  const promptTokens = usage ? (usage.input_tokens || 0) : 0;
  const completionTokens = usage ? (usage.output_tokens || 0) : 0;
  const hasToolCalls = toolCalls.length > 0;
  const created = Math.floor(Date.now() / 1000);
  const model = clientBody.model;

  // Accumulated "message pieces" for streaming: 
  // return structured result for aggregation.
  return {
    text,
    toolCalls,
    hasToolCalls,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: (promptTokens + completionTokens) },
    created,
    model,
  };
}

function nonStreamReply(agg) {
  const message = { role: 'assistant', content: agg.text.length ? agg.text : null };
  if (agg.hasToolCalls) {
    message.tool_calls = agg.toolCalls.map((tc) => ({
      id: tc.id, type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
    object: 'chat.completion',
    created: agg.created,
    model: agg.model,
    choices: [{ index: 0, message, finish_reason: agg.hasToolCalls ? 'tool_calls' : 'stop' }],
    usage: agg.usage,
  };
}

function chunkObj(agg, delta, finish) {
  const chunk = {
    id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
    object: 'chat.completion.chunk',
    created: agg.created,
    model: agg.model,
    choices: [{ index: 0, delta, finish_reason: finish === undefined ? null : finish }],
  };
  return chunk;
}

// We aggregate the backend SSE and re-emit standardized chunks to the client.
async function handleStream(clientRes, clientBody) {
  const start = process.hrtime.bigint();
  // Build/validate the request payload FIRST so client-input errors (e.g.
  // image input -> HTTP 400) are returned as a real JSON error before any
  // SSE headers are written.
  let backendBody;
  let store;
  try {
    backendBody = buildBackendBody(clientBody);
    store = await getAccess();
  } catch (e) {
    const status = e.upstreamStatus || (e.code === 400 ? 400 : 502);
    clientRes.writeHead(status, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { message: e.message, type: 'gpt_oauth_error' } }));
    log(`POST /v1/chat/completions stream model=${clientBody.model} ERROR ${status} pre-stream`);
    return;
  }

  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const write = (chunk) => clientRes.write('data: ' + JSON.stringify(chunk) + '\n\n');
  try {
    const res = await postBackend(store, backendBody);
    const agg = transformEvents(parseSSE(res.body), clientBody);
    write(chunkObj(agg, { role: 'assistant' }));
    if (agg.text.length) write(chunkObj(agg, { content: agg.text }));
    if (agg.hasToolCalls) {
      agg.toolCalls.forEach((tc, i) => {
        write(chunkObj(agg, { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] }));
      });
    }
    write(chunkObj(agg, {}, agg.hasToolCalls ? 'tool_calls' : 'stop'));
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
  } catch (e) {
    clientRes.end(`data: {"error":"${String(e.message || e).replace(/"/g, '')}"}\n\ndata: [DONE]\n\n`);
  }
  const dur = Number(process.hrtime.bigint() - start) / 1e6;
  log(`POST /v1/chat/completions stream model=${clientBody.model} ${Math.round(dur)}ms`);
}

// ---------------------------------------------------------------------------
// HTTP proxy listener
// ---------------------------------------------------------------------------
function startProxy(onStart, onPortLock) {
  const server = http.createServer(async (req, res) => {
    const start = process.hrtime.bigint();
    const url = new URL(req.url, `http://${PROXY_HOST}`);
    const method = req.method;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        if (method === 'GET' && url.pathname === '/healthz') {
          const store = loadStore();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, loggedIn: !!(store && store.refresh), modelCount: MODEL_IDS.length }));
          return;
        }
        if (method === 'GET' && url.pathname === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            object: 'list',
            data: MODEL_IDS.map((id) => ({ id, object: 'model', owned_by: MODEL_OWNED_BY })),
          }));
          return;
        }
        if (method === 'POST' && url.pathname === '/v1/chat/completions') {
          let parsed;
          try { parsed = JSON.parse(body); } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
            return;
          }
          const stream = !!parsed.stream;
          try {
            if (stream) {
              await handleStream(res, parsed);
              return;
            }
            const agg = await doChatCompletion(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(nonStreamReply(agg)));
            const dur = Number(process.hrtime.bigint() - start) / 1e6;
            log(`POST /v1/chat/completions model=${parsed.model} upstream=200 ${Math.round(dur)}ms`);
          } catch (e) {
            global.lastError = e.message;
            const status = e.upstreamStatus || (e.code === 400 ? 400 : 502);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message, type: 'gpt_oauth_error' } }));
            log(`POST /v1/chat/completions model=${parsed.model} ERROR ${status} ${Math.round(Number(process.hrtime.bigint() - start) / 1e6)}ms`);
          }
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(e.message || e) } }));
      }
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      server.removeAllListeners('error');
      handlePortLock();
    } else {
      errlog('proxy server error: ' + e.message);
    }
  });

  function handlePortLock() {
    // check healthz on the locked port
    getJSON(`http://${PROXY_HOST}:${PROXY_PORT}/healthz`, {}, 2000).then((h) => {
      if (h.status === 200) {
        log('Proxy already owned by another instance (healthz OK). MCP-only for this process.');
        onPortLock(false);
      } else {
        // not healthy -> retry
        log('Port ' + PROXY_PORT + ' busy and not healthy; will retry');
        retryLock();
      }
    }).catch(() => retryLock());
  }

  let tries = 0;
  function retryLock() {
    tries++;
    if (tries > 60) { // 30s / 500ms
      log('Port ' + PROXY_PORT + ' still locked; falling back to ' + FALLBACK_PORT);
      server.listen(FALLBACK_PORT, PROXY_HOST, () => {
        log('Proxy listening on http://' + PROXY_HOST + ':' + FALLBACK_PORT);
        onStart(FALLBACK_PORT);
      });
      return;
    }
    setTimeout(() => {
      server.listen(PROXY_PORT, PROXY_HOST, () => {
        log('Proxy listening on http://' + PROXY_HOST + ':' + PROXY_PORT);
        onStart(PROXY_PORT);
      });
    }, 500);
  }

  server.listen(PROXY_PORT, PROXY_HOST, () => {
    log('Proxy listening on http://' + PROXY_HOST + ':' + PROXY_PORT);
    onStart(PROXY_PORT);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  log('gpt-oauth server v' + VERSION + ' http=' + RUN_HTTP + ' mcp=' + RUN_MCP);
  if (RUN_MCP) startMCP();
  if (RUN_HTTP) {
    startProxy((port) => { log('Proxy ready on port ' + port); }, () => { log('No proxy owned (another instance has it).'); });
  }
}

main();
