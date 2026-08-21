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
 *   --daemon      detached HTTP-proxy-only process; logs to
 *                 ~/.zcode/gpt-oauth/daemon.log. This is the canonical
 *                 always-on form that owns port 8787 independent of MCP
 *                 sessions (spawned by ensureDaemon()).
 *   --http-only   in-process proxy only (skip MCP stdio) [used for curl tests]
 *   --mcp-only    run MCP stdio only (skip HTTP). Deliberately does NOT spawn
 *                 or ensure the daemon, so MCP-focused tests have no side
 *                 effects on port 8787.
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

const VERSION = '0.2.1';
const NAME = 'gpt-oauth';

// ---------------------------------------------------------------------------
// Process resilience: never exit on an unexpected error/rejection. Log the
// full error to stderr and keep serving (avoids "@@ -MCP Reconnecting forever"
// loops caused by a crash elsewhere in the process).
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  errlog('uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
});
process.on('unhandledRejection', (reason) => {
  errlog('unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason)));
});

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
const OAUTH_PORT = 1455;
const OAUTH_MAX_WAIT_MS = 5 * 60 * 1000;

const MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const MODEL_OWNED_BY = 'chatgpt-oauth';

// Which parts of the server run.
const args = process.argv.slice(2);
const HTTP_ONLY = args.includes('--http-only');
const MCP_ONLY = args.includes('--mcp-only');
const DAEMON = args.includes('--daemon');
// --daemon:       detached HTTP-proxy-only process, logs to daemon.log.
//                 It is the canonical always-on owner of port 8787.
// --http-only:    in-process (foreground) proxy for ad-hoc curl tests.
// --mcp-only:     MCP stdio only; intentionally does NOT spawn/ensure the
//                 daemon, so MCP-focused tests have no side effects on the port.
const RUN_MCP = !HTTP_ONLY && !DAEMON;                    // serve MCP stdio
const RUN_HTTP = !MCP_ONLY && (DAEMON || HTTP_ONLY);      // bind port 8787

// ---------------------------------------------------------------------------
// Logging (stderr, except in --daemon mode where it goes to daemon.log)
// ---------------------------------------------------------------------------
const DAEMON_LOG = path.join(TOKEN_DIR, 'daemon.log');
const DAEMON_LOG_MAX_BYTES = 1024 * 1024; // keep the last ~1MB of history

// If daemon.log has grown past DAEMON_LOG_MAX_BYTES, truncate it down to the
// trailing ~1MB (dropping the partial first line) before appending.
function truncateDaemonLogIfNeeded() {
  try {
    const st = fs.statSync(DAEMON_LOG);
    if (st.size <= DAEMON_LOG_MAX_BYTES) return;
    const fd = fs.openSync(DAEMON_LOG, 'r');
    const buf = Buffer.alloc(DAEMON_LOG_MAX_BYTES);
    const { bytesRead } = fs.readSync(fd, buf, 0, DAEMON_LOG_MAX_BYTES, Math.max(0, st.size - DAEMON_LOG_MAX_BYTES));
    fs.closeSync(fd);
    let tail = buf.slice(0, bytesRead).toString('utf8');
    const nl = tail.indexOf('\n');
    if (nl >= 0) tail = tail.slice(nl + 1);
    fs.writeFileSync(DAEMON_LOG, tail);
  } catch (e) { /* ignore */ }
}

function daemonLog(line) {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    truncateDaemonLogIfNeeded();
    fs.appendFileSync(DAEMON_LOG, line + '\n');
  } catch (e) { /* never let logging crash the daemon */ }
}

// Return the last n non-empty lines of daemon.log (or null if unavailable) —
// used by gpt_status to surface why the daemon is unhealthy.
function tailDaemonLog(n) {
  try {
    const raw = fs.readFileSync(DAEMON_LOG, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    return lines.length ? lines.slice(-n).join('\n') : null;
  } catch (e) {
    return null;
  }
}

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  if (DAEMON) daemonLog(line); else process.stderr.write(line + '\n');
}
function errlog(...a) {
  const line = `[ERR ${new Date().toISOString()}] ${a.join(' ')}`;
  if (DAEMON) daemonLog(line); else process.stderr.write(line + '\n');
}

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

function requestJSON(url, method, headers, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = driverFor(u);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: headers || {},
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function compareVersions(a, b) {
  const left = String(a || '').split('.').map((v) => Number.parseInt(v, 10) || 0);
  const right = String(b || '').split('.').map((v) => Number.parseInt(v, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) < (right[i] || 0) ? -1 : 1;
  }
  return 0;
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
    req.on('timeout', () => {
      // Upstream (e.g. the auth token endpoint during a chat-triggered refresh)
      // did not respond in time -> surface as 504.
      const e = new Error('upstream headers timeout');
      e.upstreamStatus = 504;
      req.destroy(e);
    });
    req.write(body);
    req.end();
  });
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Detached proxy daemon (v0.1.9)
//
// Port 8787 lives in a DETACHED daemon process, not inside the per-session MCP
// stdio process. When ZCode reaps an idle session it kills the MCP process; the
// daemon (new process group, reparented to PID 1 / launchd) survives, so the
// next session finds the proxy already up — no slow "reconnect after idle".
// ---------------------------------------------------------------------------
const HEALTHZ_URL = `http://${PROXY_HOST}:${PROXY_PORT}/healthz`;
const SHUTDOWN_URL = `http://${PROXY_HOST}:${PROXY_PORT}/shutdown`;

// GET /healthz; resolves to the running server's version string, or null if the
// daemon is unreachable (connection refused) or not reporting a version.
async function daemonHealth(timeoutMs = 2000) {
  try {
    const h = await getJSON(HEALTHZ_URL, {}, timeoutMs);
    if (h.status !== 200) return null;
    try { return JSON.parse(h.body).version || null; } catch (e) { return null; }
  } catch (e) {
    return null;
  }
}

// POST /shutdown with the CSRF-safe custom header, then wait for the port to
// free (the daemon exits itself ~300ms after acknowledging).
async function daemonShutdown() {
  try {
    const s = await requestJSON(SHUTDOWN_URL, 'POST', { 'x-gpt-oauth-shutdown': '1' }, 3000);
    log('Daemon /shutdown request returned status ' + s.status);
  } catch (e) {
    log('Daemon /shutdown request failed: ' + (e.message || e));
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await daemonHealth(500))) break; // port no longer serving
    await sleep(300);
  }
}

// Spawn the detached daemon (uses process.execPath so relative-executable PATH
// issues from GUI launches don't apply, and __filename is an absolute path).
function spawnDaemon() {
  const child = spawn(process.execPath, [__filename, '--daemon'], {
    detached: true,   // new process group / session: survives parent death
    stdio: 'ignore',  // daemon logs go to ~/.zcode/gpt-oauth/daemon.log
  });
  child.unref();
  return child;
}

// Ensure a healthy, at-least-this-version daemon owns port 8787.
//  - healthy (version >= VERSION): reuse it, return immediately.
//  - older version: /shutdown it (daemon-vs-daemon takeover), then spawn ours.
//  - unreachable: spawn a fresh daemon.
//  - poll /healthz every 400ms up to 20s for it to come up.
async function ensureDaemon() {
  const existing = await daemonHealth(2000);
  if (existing) {
    if (compareVersions(existing, VERSION) >= 0) {
      log('Daemon healthy (v' + existing + '); reusing it');
      return true;
    }
    log('Daemon version ' + existing + ' is older than v' + VERSION + '; takeover via /shutdown handshake');
    await daemonShutdown();
  }
  const child = spawnDaemon();
  log('Spawned detached daemon (pid ' + child.pid + ') using ' + process.execPath);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(400);
    const v = await daemonHealth(1000);
    if (v) {
      log('Daemon healthy after spawn (v' + v + '); proxy ready');
      return true;
    }
  }
  errlog('Daemon did not become healthy within 20s; proxy may be unavailable');
  return false;
}

// ---------------------------------------------------------------------------
// Refresh token
// ---------------------------------------------------------------------------
let lastUpdateCheck = { at: 0, latest: null };
const UPDATE_URL = 'https://raw.githubusercontent.com/kvu-boop/zcode-gpt-oauth/main/marketplace.json';

async function getUpdateStatus() {
  const now = Date.now();
  if (now - lastUpdateCheck.at < 60 * 60 * 1000) {
    return lastUpdateCheck.latest;
  }
  try {
    const res = await getJSON(UPDATE_URL, {}, 5000);
    if (res.status < 200 || res.status >= 300) throw new Error('update check HTTP ' + res.status);
    const data = JSON.parse(res.body);
    const latest = data && data.plugins && data.plugins[0] && data.plugins[0].version;
    if (!latest) throw new Error('update response missing version');
    lastUpdateCheck = { at: now, latest: { latestVersion: String(latest), updateAvailable: compareVersions(VERSION, latest) < 0 } };
    return lastUpdateCheck.latest;
  } catch (e) {
    lastUpdateCheck = { at: now, latest: { latestVersion: null, updateError: String(e.message || e) } };
    return lastUpdateCheck.latest;
  }
}

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
      const updateStatus = await getUpdateStatus();
      // proxyRunning == daemon healthy. If the daemon is missing we try to
      // (re)spawn it, then report the last lines of daemon.log if it still
      // won't come up. --mcp-only sessions do NOT spawn the daemon (tests).
      let proxyRunning = false;
      try {
        const h = await getJSON(HEALTHZ_URL, {}, 2000);
        proxyRunning = h.status === 200;
      } catch (e) { proxyRunning = false; }
      if (!proxyRunning && !MCP_ONLY) {
        try {
          await ensureDaemon();
          proxyRunning = !!(await daemonHealth(2000));
        } catch (e) { /* swallowed; report below */ }
      }
      let lastError = global.lastError || null;
      if (!proxyRunning) {
        const daemonTail = tailDaemonLog(5);
        if (daemonTail) lastError = daemonTail;
      }
      if (!store) {
        return mcpResult({
          loggedIn: false, email: null, accountId: null, expires: null,
          accessValid: false, proxyRunning, lastError,
          ...updateStatus,
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
        ...updateStatus,
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
        const parts = [];
        for (const c of content) {
          if (!c) continue;
          if (c.type === 'text') {
            parts.push({ type: 'input_text', text: String(c.text || '') });
          } else if (c.type === 'image_url' || c.type === 'image') {
            // data:image/...;base64,... and http(s) URLs pass through unchanged.
            const imgUrl = c.type === 'image_url' ? (c.image_url && c.image_url.url) : c.image_url;
            if (typeof imgUrl !== 'string' || !imgUrl) {
              const e = new Error('content part "' + c.type + '" missing url');
              e.code = 400;
              throw e;
            }
            parts.push({ type: 'input_image', image_url: imgUrl });
          } else {
            const e = new Error('unsupported content part type: ' + c.type);
            e.code = 400;
            throw e;
          }
        }
        input.push({ type: 'message', role: 'user', content: parts });
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
    let gotHeaders = false;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers,
      timeout: 120000, // total idle timeout once headers have arrived
    }, (res) => {
      gotHeaders = true;
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
    // TTFB guard: if the upstream has not sent response HEADERS within 45s,
    // fail fast with a 504 instead of letting the full 120s socket timeout eat
    // the request (a silently-hanging upstream must not stall the proxy).
    const headersTimer = setTimeout(() => {
      const e = new Error('upstream headers timeout (no response after 45s)');
      e.upstreamStatus = 504;
      req.destroy(e);
    }, 45000);
    req.on('error', (e) => {
      clearTimeout(headersTimer);
      reject(e);
    });
    req.on('timeout', () => {
      const e = new Error(gotHeaders ? 'upstream timeout' : 'upstream headers timeout (no response after 45s)');
      if (!gotHeaders) e.upstreamStatus = 504;
      req.destroy(e);
    });
    req.write(json);
    req.end();
    // Clear the TTFB timer once headers arrived; the socket timeout (120s)
    // remains in force for the response body after that.
    req.on('response', () => clearTimeout(headersTimer));
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
  const server = http.createServer((req, res) => {
    const start = process.hrtime.bigint();
    // Wrap the whole handler so a malformed request can never throw and crash
    // the process synchronously.
    let url;
    try {
      url = new URL(req.url, `http://${PROXY_HOST}`);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad request path' } }));
      return;
    }
    const method = req.method;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('error', () => { /* ignore client abort mid-body */ });
    req.on('end', async () => {
      try {
        if (method === 'GET' && url.pathname === '/healthz') {
          const store = loadStore();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, version: VERSION, loggedIn: !!(store && store.refresh), modelCount: MODEL_IDS.length }));
          return;
        }
        if (method === 'POST' && url.pathname === '/shutdown') {
          // CSRF-safe: only an explicit custom header (which forms can't send)
          // authorizes a shutdown. Without it -> 403.
          if (String(req.headers['x-gpt-oauth-shutdown']) !== '1') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'forbidden' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          log('Received authorized /shutdown; exiting in 300ms');
          setTimeout(() => process.exit(0), 300);
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
    // Version-aware takeover: if the existing instance is OLDER than us, shut
    // it down via the loopback handshake and take the port. Otherwise (same or
    // newer, or unreachable) fall back to MCP-only.
    getJSON(`http://${PROXY_HOST}:${PROXY_PORT}/healthz`, {}, 3000).then(async (h) => {
      let existingVersion = null;
      try { existingVersion = JSON.parse(h.body).version; } catch (e) { /* non-JSON */ }
      if (h.status === 200 && existingVersion && compareVersions(existingVersion, VERSION) < 0) {
        log(`Existing proxy on :${PROXY_PORT} is older (v${existingVersion} < v${VERSION}); taking over via /shutdown handshake`);
        await shutdownAndTakeover();
        return;
      }
      if (h.status === 200) {
        log('Proxy already owned by this/same-or-newer version (healthz OK). MCP-only for this process.');
        onPortLock(false);
      } else {
        log('Port ' + PROXY_PORT + ' busy but healthz not OK; MCP-only fallback for this process.');
        onPortLock(false);
      }
    }).catch(() => {
      log('Port ' + PROXY_PORT + ' busy and healthz unreachable; MCP-only fallback for this process.');
      onPortLock(false);
    });
  }

  async function shutdownAndTakeover() {
    try {
      const s = await requestJSON(`http://${PROXY_HOST}:${PROXY_PORT}/shutdown`, 'POST', { 'x-gpt-oauth-shutdown': '1' }, 3000);
      if (s.status !== 200) {
        log('Takeover: shutdown rejected (status ' + s.status + '); MCP-only fallback.');
        onPortLock(false);
        return;
      }
      log('Takeover: shutdown accepted; waiting for port to free');
    } catch (e) {
      log('Takeover: shutdown request failed: ' + (e.message || e) + '; MCP-only fallback.');
      onPortLock(false);
      return;
    }
    // Poll healthz until the old process is gone (its socket closed), up to 10s.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      let available = false;
      try {
        await getJSON(`http://${PROXY_HOST}:${PROXY_PORT}/healthz`, {}, 1000);
      } catch (e) {
        available = true; // connection refused -> port no longer serving
      }
      if (available) break;
      await sleep(300);
    }
    // Retry listening on 8787 (10 attempts, 500ms apart).
    for (let i = 0; i < 10; i++) {
      const ok = await new Promise((resolve) => {
        server.removeAllListeners('error');
        server.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? 'busy' : e));
        server.listen(PROXY_PORT, PROXY_HOST, () => resolve('ok'));
      });
      if (ok === 'ok') {
        log('Takeover successful: proxy listening on http://' + PROXY_HOST + ':' + PROXY_PORT);
        onStart(PROXY_PORT);
        return;
      }
      if (ok !== 'busy') {
        errlog('Takeover: listen error: ' + (ok.message || ok));
        onPortLock(false);
        return;
      }
      log('Takeover retry ' + (i + 1) + ': port still busy; retrying in 500ms');
      await sleep(500);
    }
    log('Takeover failed after 10 attempts; MCP-only fallback.');
    onPortLock(false);
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
async function main() {
  log('gpt-oauth server v' + VERSION + ' mode=' + (DAEMON ? 'daemon' : (HTTP_ONLY ? 'http-only' : 'mcp')) + ' http=' + RUN_HTTP + ' mcp=' + RUN_MCP);
  if (DAEMON) {
    // Detached daemon: sole owner of port 8787, logs to daemon.log.
    startProxy((port) => { log('Proxy daemon ready on port ' + port); }, () => {
      // An equal-or-newer daemon already owns the port; this process is
      // redundant (e.g. a version race), so exit quietly.
      log('Another daemon owns port ' + PROXY_PORT + '; this daemon exits');
      process.exit(0);
    });
    return;
  }
  if (RUN_MCP) {
    // Ensure the detached daemon is up BEFORE MCP stdio begins, so the proxy
    // is available immediately for this (and every future) session. MCP-only
    // sessions deliberately skip this to keep tests side-effect free.
    if (!MCP_ONLY) {
      try {
        await ensureDaemon();
      } catch (e) {
        errlog('ensureDaemon failed: ' + (e && e.stack ? e.stack : String(e)));
      }
    }
    startMCP();
    return;
  }
  if (RUN_HTTP) {
    startProxy((port) => { log('Proxy ready on port ' + port); }, () => { log('No proxy owned (another instance has it).'); });
  }
}

main().catch((e) => {
  errlog('startup failure: ' + (e && e.stack ? e.stack : String(e)));
});
