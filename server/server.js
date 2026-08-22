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

const { normalizeProviderUsage } = require('./cache/adapters');
const { createTracker } = require('./cache/detector');
const { resolvePricing } = require('./cache/pricing');
const { calculateAdditionalCacheMissCost } = require('./cache/cost');
const { buildCacheNotice } = require('./cache/notice');

const VERSION = '0.2.6';
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
// Overridable so the SSE/streaming tests can point the proxy at a local
// slow-upstream harness. Default is the production Codex backend.
const BACKEND_BASE = process.env.GPT_OAUTH_BACKEND_BASE || 'https://chatgpt.com/backend-api/codex';
const cacheTracker = createTracker();
const HOME_OVERRIDE = process.env.GPT_OAUTH_HOME || (process.env.NODE_ENV === 'test' ? process.env.HOME : null);
const PROXY_HOST = process.env.GPT_OAUTH_PROXY_HOST || '127.0.0.1';
const PROXY_PORT = Number(process.env.GPT_OAUTH_PROXY_PORT || 8787);


// OAuth flow matching the Codex CLI (opencode-openai-codex-auth).
const REDIRECT_PATH = '/auth/callback';
const REDIRECT_HOST = 'localhost';
const SCOPE = 'openid profile email offline_access';

const ZCODE_DIR = path.join(HOME_OVERRIDE || os.homedir(), '.zcode');
const TOKEN_DIR = path.join(ZCODE_DIR, 'gpt-oauth');
const TOKEN_FILE = path.join(TOKEN_DIR, 'auth.json');
const SETTINGS_FILE = path.join(TOKEN_DIR, 'settings.json');
const OPENCODE_AUTH = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

function parseBooleanEnv(value) {
  if (value === undefined || value === null || value === '') return null;
  if (/^(?:1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(?:0|false|no|off)$/i.test(String(value))) return false;
  return null;
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) {
    return {};
  }
}

function saveSettings(patch) {
  const settings = { ...loadSettings(), ...patch };
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
  fs.chmodSync(SETTINGS_FILE, 0o600);
  return settings;
}

const ENV_CACHE_MISS_NOTICES = parseBooleanEnv(process.env.GPT_OAUTH_CACHE_MISS_NOTICES);
const PERSISTED_CACHE_MISS_NOTICES = loadSettings().cacheMissNotices === true;
const CACHE_MISS_NOTICES = ENV_CACHE_MISS_NOTICES === null ? PERSISTED_CACHE_MISS_NOTICES : ENV_CACHE_MISS_NOTICES;

const OAUTH_PORT = 1455;
const OAUTH_MAX_WAIT_MS = 5 * 60 * 1000;

const MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const MODEL_OWNED_BY = 'chatgpt-oauth';

// Streaming (v0.2.2): bounds for the incremental SSE forwarder.
const STREAM_HEADERS_TIMEOUT_MS = 45000;  // upstream response headers must arrive within this
const STREAM_IDLE_TIMEOUT_MS = 45000;     // upstream must send data this often once headers arrive
const STREAM_HEARTBEAT_MS = 10000;        // client-side `: keep-alive` SSE comment while streaming

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
const DEFAULT_PROXY_PORT = 8787;

// A test process must never accidentally become the production proxy. Keep an
// explicit port override available for isolated HTTP integration fixtures.
function refuseTestProductionProxy() {
  if (process.env.NODE_ENV === 'test' && RUN_HTTP && PROXY_PORT === DEFAULT_PROXY_PORT && !process.env.GPT_OAUTH_PROXY_PORT) {
    process.stderr.write('REFUSING TO BIND production proxy port 8787 from NODE_ENV=test; set GPT_OAUTH_PROXY_PORT for an isolated test port.\\n');
    process.exit(1);
  }
  return false;
}

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
async function daemonHealthState(timeoutMs = 2000) {
  try {
    const h = await getJSON(HEALTHZ_URL, {}, timeoutMs);
    if (h.status !== 200) return null;
    const state = JSON.parse(h.body);
    return state && state.version ? state : null;
  } catch (e) {
    return null;
  }
}

async function daemonHealth(timeoutMs = 2000) {
  const state = await daemonHealthState(timeoutMs);
  return state && state.version || null;
}

async function restartDaemonForCacheSetting(desired) {
  // MCP-only sessions must not affect the detached production daemon.
  if (MCP_ONLY) return { restarted: false, state: null };
  const state = await daemonHealthState(2000);
  if (!state) {
    const ok = await ensureDaemon();
    return { restarted: ok, state: await daemonHealthState(2000) };
  }
  if (state.cacheMissNotices === desired) return { restarted: false, state };
  await daemonShutdown();
  const ok = await ensureDaemon();
  const finalState = await daemonHealthState(2000);
  return { restarted: ok, state: finalState };
}

function effectiveCacheMissNotices() {
  const env = parseBooleanEnv(process.env.GPT_OAUTH_CACHE_MISS_NOTICES);
  if (env !== null) return env;
  return loadSettings().cacheMissNotices === true;
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
  // Detached daemons are production processes, even when launched by a test
  // or temporary MCP environment. Never inherit test identity, token, or port
  // overrides. A daemon always uses the real account home for token discovery.
  const env = { ...process.env };
  delete env.GPT_OAUTH_HOME;
  delete env.GPT_OAUTH_PROXY_PORT;
  if (process.env.NODE_ENV === 'test') env.NODE_ENV = 'production';
  env.HOME = os.homedir();
  const child = spawn(process.execPath, [__filename, '--daemon'], {
    detached: true,   // new process group / session: survives parent death
    stdio: 'ignore',  // daemon logs go to ~/.zcode/gpt-oauth/daemon.log
    env,
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
    case 'gpt_cache_miss_notices': {
      if (typeof params.enabled !== 'boolean') return mcpError('gpt_cache_miss_notices failed: enabled must be a boolean');
      if (ENV_CACHE_MISS_NOTICES !== null && ENV_CACHE_MISS_NOTICES !== params.enabled) {
        return mcpError('gpt_cache_miss_notices failed: GPT_OAUTH_CACHE_MISS_NOTICES explicitly overrides the requested setting');
      }
      const before = effectiveCacheMissNotices();
      saveSettings({ cacheMissNotices: params.enabled });
      if (before === params.enabled) return mcpResult({ ok: true, cacheMissNotices: params.enabled, proxyRestarted: false });
      if (MCP_ONLY) {
        return mcpResult({ ok: true, cacheMissNotices: params.enabled, proxyRestarted: false });
      }
      const result = await restartDaemonForCacheSetting(params.enabled);
      const active = result.state && result.state.cacheMissNotices;
      if (!result.state || active !== params.enabled) {
        return mcpError('gpt_cache_miss_notices failed: daemon did not report requested state');
      }
      return mcpResult({ ok: true, cacheMissNotices: active, proxyRestarted: !!result.restarted });
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
          accessValid: false, proxyRunning, cacheMissNotices: CACHE_MISS_NOTICES, lastError,
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
        cacheMissNotices: CACHE_MISS_NOTICES,
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
              name: 'gpt_cache_miss_notices',
              description: 'Enable or disable persistent cache-miss notices.',
              inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false },
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
function consumeCacheControl(body) {
  const control = body && body.cache_control && typeof body.cache_control === 'object' ? body.cache_control : {};
  if (body && Object.prototype.hasOwnProperty.call(body, 'cache_control')) delete body.cache_control;
  return {
    sessionId: typeof control.session_id === 'string' && control.session_id ? control.session_id : null,
    lineageId: typeof control.lineage_id === 'string' && control.lineage_id ? control.lineage_id : null,
    reset: control.reset === true,
    pricingTier: typeof control.pricing_tier === 'string' && control.pricing_tier ? control.pricing_tier : null,
    contextBand: typeof control.context_band === 'string' && control.context_band ? control.context_band : null,
    timeBand: typeof control.time_band === 'string' && control.time_band ? control.time_band : null,
  };
}

function cacheRequestToken(clientBody) {
  if (!CACHE_MISS_NOTICES) return null;
  const c = clientBody._cacheControl || {};
  return cacheTracker.begin(normalizeProviderUsage({
    provider: 'chatgpt-oauth', schema: 'openai-responses', model: clientBody.model,
    rawUsage: null, observedAtMs: Date.now(), sessionId: c.sessionId, lineageId: c.lineageId,
    pricingTier: c.pricingTier,
  }), { reset: c.reset });
}

function cacheAnalytics(rawUsage, clientBody, observedAtMs, token) {
  if (!CACHE_MISS_NOTICES || !rawUsage) return null;
  try {
    const control = clientBody && clientBody._cacheControl || {};
    const usage = normalizeProviderUsage({
      provider: 'chatgpt-oauth', schema: 'openai-responses', model: clientBody.model,
      rawUsage, observedAtMs, sessionId: control.sessionId, lineageId: control.lineageId,
      pricingTier: control.pricingTier,
    });
    const pricing = resolvePricing({ provider: usage.provider, model: usage.model, tier: control.pricingTier, contextBand: control.contextBand, timeBand: control.timeBand, observedAtMs, inputTokens: usage.inputTokens && usage.inputTokens.value });
    const detection = token ? cacheTracker.preview(token, usage, { reset: control.reset, policy: { enabled: true }, pricingContext: { cost: null } }) : null;
    if (!detection) return { usage, notice: null };
    const cost = calculateAdditionalCacheMissCost({ missedTokens: detection.missedTokens, usage, priceResolution: pricing });
    if (cost) detection.cost = cost;
    return { usage, notice: buildCacheNotice(detection, pricing) };
  } catch (e) {
    return null;
  }
}

function cacheUsageExtension(usage) {
  if (!usage) return null;
  const out = { provider: usage.provider, model: usage.model, cacheTelemetry: usage.cacheTelemetry, telemetrySchema: usage.telemetrySchema, capabilityId: usage.capabilityId };
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheMissTokens', 'uncachedInputTokens', 'cacheHitRate']) {
    if (usage[key]) out[key] = usage[key];
  }
  return out;
}

// Cancellation is deliberately delegated to the detector so stale request
// tokens cannot clear a newer request's in-flight generation.
function cancelCacheToken(token) {
  if (!token) return;
  if (typeof cacheTracker.cancel === 'function') {
    cacheTracker.cancel(token);
    return;
  }
  // Compatibility with an older detector loaded by a stale daemon. Preserve
  // its stale-token guard while releasing only this generation.
  const record = cacheTracker.records && cacheTracker.records.get(token.id);
  if (record && record.inFlight && record.inFlight.generation === token.generation) record.inFlight = null;
}

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

// Stateful incremental SSE parser used by the streaming forwarder. Handles TCP
// splits (partial blocks arriving across `data` events), LF/CRLF line endings,
// multi-line `data:` fields, `event:` names, non-JSON/comment lines and the
// `[DONE]` sentinel WITHOUT buffering the entire upstream body.
function createSSEParser(onEvent, onDone) {
  let buffer = '';
  function emitBlock(block) {
    let data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        const piece = line.slice(5).replace(/^ /, '');
        data = data === null ? piece : data + '\n' + piece;
      }
    }
    if (data === null) return;
    const trimmed = data.trim();
    if (!trimmed) return;
    if (trimmed === '[DONE]') {
      if (onDone) onDone();
      return;
    }
    try { onEvent(JSON.parse(trimmed)); } catch (e) { /* skip non-JSON */ }
  }
  return {
    push(chunk) {
      buffer += String(chunk);
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        emitBlock(block);
      }
    },
    flush() {
      if (buffer.trim().length) {
        const block = buffer;
        buffer = '';
        emitBlock(block);
      }
    },
  };
}

// Best-effort extraction of a human-readable message from an upstream error
// body ({error:{message}} / {message} / plain text). Never logs tokens.
function extractUpstreamError(status, body) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    if (j && j.error) {
      if (typeof j.error === 'string') msg = j.error;
      else if (j.error.message) msg = String(j.error.message);
    } else if (j && typeof j.message === 'string') {
      msg = j.message;
    }
  } catch (e) { /* non-JSON body */ }
  if (!msg) msg = String(body || '').slice(0, 300).trim();
  if (!msg) msg = 'upstream error ' + status;
  if (status === 404) msg = 'model not found on backend: ' + msg;
  return msg.slice(0, 500);
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

// Incremental upstream response streaming (v0.2.2). POSTs the Responses request
// and hands every SSE chunk to handlers.onData as it arrives — nothing is
// buffered. Terminal outcomes:
//   - 2xx:  handlers.onStatus(status) then onData/onEnd
//   - 401 (first attempt): refresh the access token and retry once, notifying
//     handlers.onRetry401
//   - other non-2xx: reads the (bounded) error body, ends with handlers.onError
//   - headers timeout (SOCKS/TLS/HTTP headers not received in 45s): 504 error
//   - idle-data timeout (no upstream data for 45s after headers): 502 error
// handlers: { onStatus, onData, onEnd, onRetry401, onError }
function upstreamStream(store, body, handlers) {
  let req = null;
  let attempt = 0;
  let settled = false;

  function fail(err) {
    if (settled) return;
    settled = true;
    handlers.onError(err);
    try { if (req) req.destroy(); } catch (e) { /* ignore */ }
  }

  function start(tok) {
    if (!tok) { fail(Object.assign(new Error('re-login required (no token)'), { upstreamStatus: 401 })); return; }
    const u = new URL(`${BACKEND_BASE}/responses`);
    const json = JSON.stringify(body);
    const headers = {
      'Authorization': 'Bearer ' + tok.access,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'User-Agent': 'codex_cli_rs/0.42.0 (macOS 15.2; arm64)',
      'originator': 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
    };
    if (tok.accountId) headers['chatgpt-account-id'] = tok.accountId;
    const mod = driverFor(u);

    // Headers timeout: 45s from connection attempt until response headers.
    const headersTimer = setTimeout(() => {
      const e = new Error('upstream headers timeout (no response after 45s)');
      e.upstreamStatus = 504;
      fail(e);
    }, STREAM_HEADERS_TIMEOUT_MS);
    if (headersTimer.unref) headersTimer.unref();

    req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
      method: 'POST', headers,
    }, (res) => {
      try { clearTimeout(headersTimer); } catch (e) { /* ignore */ }
      if (res.statusCode === 401 && attempt === 0) {
        // Drain the small 401 body, then refresh once and retry.
        attempt++;
        res.resume();
        res.on('end', () => {
          handlers.onRetry401();
          refreshAccess(tok).then(() => {
            if (settled) return;
            start(loadStore());
          }).catch((e) => fail(e));
        });
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // Read a bounded error body then fail terminally (client already has
        // SSE headers; the caller turns this into an SSE error + [DONE]).
        let buf = '';
        res.on('data', (c) => { if (buf.length < 8192) buf += c; });
        res.on('end', () => {
          const e = new Error(extractUpstreamError(res.statusCode, buf));
          e.upstreamStatus = res.statusCode;
          fail(e);
        });
        res.on('error', () => fail(new Error('upstream error ' + res.statusCode)));
        return;
      }
      handlers.onStatus(res.statusCode);
      // Idle-data timeout: reset on every chunk, abort if upstream stalls.
      const idle = setTimeout(() => {
        const e = new Error('upstream idle timeout (no data after 45s)');
        e.upstreamStatus = 502;
        fail(e);
      }, STREAM_IDLE_TIMEOUT_MS);
      if (idle.unref) idle.unref();
      const resetIdle = () => { try { idle.refresh(); } catch (e) { /* ignore */ } };
      res.on('data', (c) => { resetIdle(); handlers.onData(c); });
      res.on('end', () => {
        try { clearTimeout(idle); } catch (e) { /* ignore */ }
        if (!settled) { settled = true; handlers.onEnd(); }
      });
      res.on('error', (e) => {
        try { clearTimeout(idle); } catch (x) { /* ignore */ }
        fail(e && e.message ? e : new Error('upstream response error'));
      });
    });
    req.on('error', (e) => {
      if (settled) return; // timeout path already handled it
      settled = true;
      handlers.onError(e && e.message ? e : new Error('upstream request failed'));
    });
    req.write(json);
    req.end();
  }

  start(store);
  return {
    abort() { settled = true; try { if (req) req.destroy(); } catch (e) { /* ignore */ } },
  };
}

// Transform a chat.completions request into codex response events / final obj.
async function doChatCompletion(clientBody) {
  const store = await getAccess();
  clientBody._cacheControl = clientBody._cacheControl || consumeCacheControl(clientBody);
  const cacheToken = clientBody._cacheToken || cacheRequestToken(clientBody);
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
  return transformEvents(events, clientBody, cacheToken);
}

function transformEvents(events, clientBody, cacheToken) {
  let text = '';
  const toolCalls = []; // {id,name,arguments}
  let usage = null;
  let cacheAnalyticsResult = null;
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
  cacheAnalyticsResult = cacheAnalytics(usage, clientBody, Date.now(), cacheToken);

  // Accumulated "message pieces" for streaming: 
  // return structured result for aggregation.
  return {
    text,
    toolCalls,
    hasToolCalls,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: (promptTokens + completionTokens) },
    created,
    model,
    cacheUsage: cacheAnalyticsResult && cacheUsageExtension(cacheAnalyticsResult.usage),
    cacheNotice: cacheAnalyticsResult && cacheAnalyticsResult.notice,
    cacheAnalyticsResult,
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
    ...(agg.cacheUsage ? { cache_usage: agg.cacheUsage } : {}),
    ...(agg.cacheNotice ? { cache_notice: agg.cacheNotice } : {}),
  };
}

// ---------------------------------------------------------------------------
// Streaming (v0.2.2): incremental forwarder.
//
// Client SSE headers are written immediately (flushHeaders), a `role` chunk is
// emitted, and each upstream Responses event is converted to a standard
// `chat.completion.chunk` as it arrives — nothing is buffered until the
// upstream completes. A `: keep-alive` SSE comment is sent every 10s while the
// upstream is active so OpenAI-compatible clients never idle-timeout on long
// generations. Upstream failures behave terminally: JSON before client headers,
// SSE error + `data: [DONE]` after them.
// ---------------------------------------------------------------------------
async function handleStream(clientRes, clientBody) {
  const start = process.hrtime.bigint();
  const startedAt = Date.now();
  const model = clientBody.model;
  const created = Math.floor(Date.now() / 1000);
  const chunkId = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
  const nowMs = () => Date.now() - startedAt;

  // Build/validate the request payload FIRST so client-input errors (e.g.
  // image input -> HTTP 400) are returned as a real JSON error before any
  // SSE headers are written.
  let backendBody;
  let store;
  let cacheToken;
  try {
    clientBody._cacheControl = clientBody._cacheControl || consumeCacheControl(clientBody);
    cacheToken = clientBody._cacheToken || cacheRequestToken(clientBody);
    backendBody = buildBackendBody(clientBody);
    store = await getAccess();
  } catch (e) {
    cancelCacheToken(cacheToken || clientBody._cacheToken);
    const status = e.upstreamStatus || (e.code === 400 ? 400 : 502);
    clientRes.writeHead(status, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { message: e.message, type: 'gpt_oauth_error' } }));
    log(`POST /v1/chat/completions stream model=${model} ERROR ${status} pre-stream`);
    return;
  }
  log(`POST /v1/chat/completions stream model=${model} start`);

  const state = {
    clientHeadersSent: false,
    upstreamStatus: null,
    upstreamHeadersMs: null,
    firstEventMs: null,
    chunks: 0,
    events: 0,
    toolOrder: [],        // function_call call_ids in arrival order
    toolIndex: new Map(), // call_id -> chunk index
    toolArgs: new Map(),  // call_id -> accumulated arguments
    toolArgsStreamed: new Set(), // call_ids whose args arrived as deltas
    usage: null,
    cacheAnalytics: null,
    cacheToken: clientBody._cacheToken || cacheRequestToken(clientBody),
    finished: false,
  };
  let heartbeat = null;
  let upstream = null;
  let clientClosed = false;

  const send = (s) => {
    if (clientClosed || state.finished) return false;
    try { return clientRes.write(s); } catch (e) { return false; }
  };
  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };

  const emitChunk = (delta, finish, extra) => {
    if (state.finished || !state.clientHeadersSent) return;
    const chunk = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish === undefined ? null : finish }],
    };
    if (extra) Object.assign(chunk, extra);
    state.chunks++;
    send('data: ' + JSON.stringify(chunk) + '\n\n');
  };

  const finish = (ok, err) => {
    if (state.finished) return;
    if (!ok && state.cacheToken) {
      cancelCacheToken(state.cacheToken);
      state.cacheToken = null;
    }
    state.finished = true;
    stopHeartbeat();
    if (upstream) { try { upstream.abort(); } catch (e) { /* ignore */ } upstream = null; }
    const durMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    if (ok) {
      log(`POST /v1/chat/completions stream model=${model} done ${durMs}ms upstream_headers=${state.upstreamHeadersMs === null ? '-' : state.upstreamHeadersMs}ms first_event=${state.firstEventMs === null ? '-' : state.firstEventMs}ms events=${state.events} chunks=${state.chunks}`);
    } else {
      const status = err && err.upstreamStatus ? ' status=' + err.upstreamStatus : '';
      log(`POST /v1/chat/completions stream model=${model} ERROR${status} ${durMs}ms events=${state.events} chunks=${state.chunks}: ${err && err.message ? err.message : err}`);
      global.lastError = err && err.message ? err.message : String(err);
    }
    try {
      state.finished = true;
      clientRes.end(() => {
        if (ok && state.pendingCacheCommit && !clientRes.destroyed && !clientRes.writableAborted && state.cacheToken) {
          cacheTracker.commit(state.cacheToken, state.pendingCacheCommit, { reset: clientBody._cacheControl.reset });
          state.cacheToken = null;
        } else if (!ok) {
          cancelCacheToken(state.cacheToken);
          state.cacheToken = null;
        }
      });
    } catch (e) {
      cancelCacheToken(state.cacheToken);
      state.cacheToken = null;
    }
  };

  const completeStream = () => {
    if (state.finished || clientClosed) return;
    const hasToolCalls = state.toolOrder.length > 0;
    let usage;
    if (state.usage) {
      usage = {
        prompt_tokens: state.usage.input_tokens || 0,
        completion_tokens: state.usage.output_tokens || 0,
        total_tokens: (state.usage.input_tokens || 0) + (state.usage.output_tokens || 0),
      };
      state.cacheAnalytics = cacheAnalytics(state.usage, clientBody, Date.now(), state.cacheToken);
    }
    const terminalExtra = usage ? { usage } : {};
    if (state.cacheAnalytics && state.cacheAnalytics.usage) terminalExtra.cache_usage = cacheUsageExtension(state.cacheAnalytics.usage);
    if (state.cacheAnalytics && state.cacheAnalytics.notice) terminalExtra.cache_notice = state.cacheAnalytics.notice;
    emitChunk({}, hasToolCalls ? 'tool_calls' : 'stop', Object.keys(terminalExtra).length ? terminalExtra : undefined);
    if (!state.finished && send('data: [DONE]\n\n') && state.cacheToken && state.cacheAnalytics && state.cacheAnalytics.usage) {
      state.pendingCacheCommit = state.cacheAnalytics.usage;
    } else if (!state.cacheAnalytics || !state.cacheAnalytics.usage) {
      cancelCacheToken(state.cacheToken);
      state.cacheToken = null;
    }
    finish(true);
  };

  const failStream = (err) => {
    if (state.finished) return;
    const msg = String(err && err.message ? err.message : err || 'stream error').replace(/[\r\n]+/g, ' ').slice(0, 500);
    if (!state.clientHeadersSent) {
      const status = (err && err.upstreamStatus) || (err && err.code === 400 ? 400 : 502);
      try {
        clientRes.writeHead(status, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: msg, type: 'gpt_oauth_error' } }));
      } catch (e) { /* ignore */ }
      finish(false, err);
      return;
    }
    send('data: ' + JSON.stringify({ error: { message: msg, type: 'gpt_oauth_error' } }) + '\n\n');
    if (!state.finished) send('data: [DONE]\n\n');
    finish(false, err);
  };

  // Convert upstream Responses events into standard chat.completion.chunks.
  function onUpstreamEvent(ev) {
    if (state.finished) return;
    if (state.firstEventMs === null) state.firstEventMs = nowMs();
    state.events++;
    const type = ev.type;
    if (type === 'response.output_text.delta') {
      if (typeof ev.delta === 'string' && ev.delta.length) emitChunk({ content: ev.delta });
    } else if (type === 'response.output_item.added') {
      const item = ev.item;
      if (item && item.type === 'function_call') {
        const index = state.toolOrder.length;
        state.toolOrder.push(item.call_id);
        state.toolIndex.set(item.call_id, index);
        state.toolArgs.set(item.call_id, '');
        if (item.name) {
          emitChunk({ tool_calls: [{ index, id: item.call_id, type: 'function', function: { name: item.name, arguments: '' } }] });
        }
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const callId = ev.item && ev.item.call_id;
      const delta = typeof ev.delta === 'string' ? ev.delta : '';
      if (callId && state.toolIndex.has(callId)) {
        const index = state.toolIndex.get(callId);
        state.toolArgs.set(callId, (state.toolArgs.get(callId) || '') + delta);
        state.toolArgsStreamed.add(callId);
        if (delta.length) emitChunk({ tool_calls: [{ index, function: { arguments: delta } }] });
      }
    } else if (type === 'response.output_item.done') {
      const item = ev.item;
      if (item && item.type === 'function_call') {
        const args = typeof item.arguments === 'string' ? item.arguments : (item.arguments ? JSON.stringify(item.arguments) : '{}');
        if (state.toolIndex.has(item.call_id)) {
          state.toolArgs.set(item.call_id, args);
          // Only replay the full arguments if we did not already stream them
          // as `function_call_arguments` deltas (the deltas concatenate).
          if (!state.toolArgsStreamed.has(item.call_id)) {
            emitChunk({ tool_calls: [{ index: state.toolIndex.get(item.call_id), function: { arguments: args } }] });
          }
        } else {
          // No `output_item.added` seen: emit the complete tool-call chunk here.
          const index = state.toolOrder.length;
          state.toolOrder.push(item.call_id);
          state.toolIndex.set(item.call_id, index);
          emitChunk({ tool_calls: [{ index, id: item.call_id, type: 'function', function: { name: item.name || '', arguments: args } }] });
        }
      }
    } else if (type === 'response.completed') {
      const r = ev.response;
      if (r && r.usage) state.usage = r.usage;
      completeStream();
    } else if (type === 'response.failed' || type === 'response.error' || type === 'error') {
      const msg = (typeof ev.message === 'string' && ev.message) || (ev.error && (ev.error.message || String(ev.error))) || (ev.code ? ev.code + ': backend error' : 'backend error');
      const e = new Error(String(msg));
      e.upstreamStatus = 502;
      failStream(e);
    }
    // Other events (response.created, response.in_progress, response.output_item.done
    // for messages, response.output_text.done, ...) are intentionally ignored.
  }

  // SSE headers first, flushed immediately so the client sees the stream.
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof clientRes.flushHeaders === 'function') clientRes.flushHeaders();
  state.clientHeadersSent = true;

  // First chunk carries the assistant role, per the Chat Completions convention.
  emitChunk({ role: 'assistant' });

  // Client heartbeat while the upstream request is active.
  heartbeat = setInterval(() => { send(': keep-alive\n\n'); }, STREAM_HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  clientRes.on('close', () => {
    clientClosed = true;
    if (!state.finished && state.cacheToken) {
      cancelCacheToken(state.cacheToken);
      state.cacheToken = null;
    }
    stopHeartbeat();
    if (upstream) { try { upstream.abort(); } catch (e) { /* ignore */ } upstream = null; }
  });

  // Incremental upstream SSE -> converted chunks.
  const parser = createSSEParser(onUpstreamEvent, () => { if (!state.finished) completeStream(); });
  upstream = upstreamStream(store, backendBody, {
    onStatus: (status) => {
      state.upstreamStatus = status;
      state.upstreamHeadersMs = nowMs();
      log(`POST /v1/chat/completions stream model=${model} upstream headers ${status} (${state.upstreamHeadersMs}ms)`);
    },
    onData: (chunk) => parser.push(chunk),
    onEnd: () => {
      parser.flush();
      if (!state.finished) completeStream();
    },
    onRetry401: () => log(`POST /v1/chat/completions stream model=${model} upstream 401 -> refresh & retry`),
    onError: (err) => failStream(err),
  });
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
          res.end(JSON.stringify({ ok: true, version: VERSION, loggedIn: !!(store && store.refresh), cacheMissNotices: CACHE_MISS_NOTICES, modelCount: MODEL_IDS.length }));
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
            parsed._cacheControl = consumeCacheControl(parsed);
            parsed._cacheToken = cacheRequestToken(parsed);
            if (stream) {
              await handleStream(res, parsed);
              return;
            }
            const agg = await doChatCompletion(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const payload = JSON.stringify(nonStreamReply(agg));
            let responseEnded = false;
            const cancelIfUncommitted = () => {
              if (!responseEnded && parsed._cacheToken) {
                cancelCacheToken(parsed._cacheToken);
                parsed._cacheToken = null;
              }
            };
            res.once('aborted', cancelIfUncommitted);
            res.once('close', cancelIfUncommitted);
            res.once('error', cancelIfUncommitted);
            res.end(payload, () => {
              if (!res.destroyed && !res.writableAborted && parsed._cacheToken && agg.cacheAnalyticsResult) {
                cacheTracker.commit(parsed._cacheToken, agg.cacheAnalyticsResult.usage, { reset: parsed._cacheControl.reset });
              } else {
                cancelIfUncommitted();
              }
              responseEnded = true;
              parsed._cacheToken = null;
            });
            const dur = Number(process.hrtime.bigint() - start) / 1e6;
            log(`POST /v1/chat/completions model=${parsed.model} upstream=200 ${Math.round(dur)}ms`);
          } catch (e) {
            cancelCacheToken(parsed._cacheToken);
            parsed._cacheToken = null;
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
  if (refuseTestProductionProxy()) return;
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
