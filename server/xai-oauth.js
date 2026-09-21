'use strict';

/*
 * xAI device-code OAuth for the ZCode plugin.
 *
 * This file deliberately has no runtime dependencies.  Network, clock, sleep,
 * browser, and logging operations are injectable so the OAuth state machine can
 * be tested without contacting xAI.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_DEVICE_AUTHORIZATION_URL = 'https://auth.x.ai/oauth2/device/code';
const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const XAI_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_REFERRER = 'zcode';
const XAI_USER_AGENT = 'zcode-gpt-oauth/0.3.1';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_SECONDS = 600;
const DEFAULT_REFRESH_EXPIRES_SECONDS = 3600;
const DEFAULT_EXPIRY_SKEW_MS = 60 * 1000;
const DEFAULT_DEVICE_SAFETY_MARGIN_MS = 3 * 1000;
const MIN_POLL_INTERVAL_MS = 1000;

const DEFAULT_ENDPOINTS = Object.freeze({
  deviceAuthorizationUrl: XAI_DEVICE_AUTHORIZATION_URL,
  tokenUrl: XAI_TOKEN_URL,
});

class XaiOAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XaiOAuthError';
    this.code = code;
  }
}

function oauthError(code, message) {
  return new XaiOAuthError(code, message);
}

function positiveNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function asInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function safeErrorCode(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/i.test(value)
    ? value
    : 'oauth_error';
}

function jsonBody(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    throw oauthError('invalid_response', 'xAI OAuth returned malformed JSON');
  }
}

function responseStatus(response) {
  if (response && response.ok === true && response.status === undefined && response.statusCode === undefined) return 200;
  return Number(response && (response.statusCode ?? response.status)) || 0;
}

async function responseBody(response, maxBytes) {
  if (!response) return '';
  if (typeof response.json === 'function') {
    const value = await response.json();
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > maxBytes) throw oauthError('response_too_large', 'xAI OAuth response was too large');
    return body.toString('utf8');
  }
  if (response.json !== undefined) {
    const body = Buffer.from(JSON.stringify(response.json));
    if (body.length > maxBytes) throw oauthError('response_too_large', 'xAI OAuth response was too large');
    return body.toString('utf8');
  }
  if (response.body !== undefined) {
    if (response.body && typeof response.body === 'object' && !Buffer.isBuffer(response.body)) {
      const body = Buffer.from(JSON.stringify(response.body));
      if (body.length > maxBytes) throw oauthError('response_too_large', 'xAI OAuth response was too large');
      return body.toString('utf8');
    }
    const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(String(response.body));
    if (body.length > maxBytes) throw oauthError('response_too_large', 'xAI OAuth response was too large');
    return body.toString('utf8');
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw oauthError('response_too_large', 'xAI OAuth response was too large');
    return text;
  }
  return '';
}

function defaultRequest(url, options = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const maxBytes = positiveNumber(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const body = options.body === undefined || options.body === null ? '' : String(options.body);
  const headers = { ...(options.headers || {}) };
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (error instanceof XaiOAuthError) return reject(error);
      reject(oauthError('network_error', 'xAI OAuth request failed'));
    };
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: options.method || 'GET',
      headers,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          fail(oauthError('response_too_large', 'xAI OAuth response was too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', fail);
    });
    request.on('timeout', () => {
      request.destroy();
      fail(oauthError('timeout', 'xAI OAuth request timed out'));
    });
    request.on('error', fail);
    if (body) request.write(body);
    request.end();
  });
}

async function callRequest(request, url, options) {
  let response;
  try {
    response = await request(url, options);
  } catch (error) {
    if (error instanceof XaiOAuthError) throw error;
    throw oauthError('network_error', 'xAI OAuth request failed');
  }
  const status = responseStatus(response);
  const body = await responseBody(response, positiveNumber(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES));
  let parsed;
  try {
    parsed = jsonBody(body);
  } catch (error) {
    if (status < 200 || status >= 300) {
      throw oauthError('http_error', 'xAI OAuth request failed with HTTP ' + status);
    }
    throw error;
  }
  if (status < 200 || status >= 300) {
    const code = safeErrorCode(parsed.error);
    throw oauthError(code, 'xAI OAuth request failed with HTTP ' + status);
  }
  return parsed;
}

function formRequestOptions(form, options = {}) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': XAI_USER_AGENT,
      ...(options.headers || {}),
    },
    body: new URLSearchParams(form).toString(),
    timeoutMs: positiveNumber(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    maxResponseBytes: positiveNumber(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
  };
}

function normalizeDevice(device) {
  if (!device || typeof device !== 'object' || typeof device.device_code !== 'string' || !device.device_code) {
    throw oauthError('invalid_response', 'xAI OAuth did not return a device code');
  }
  const expiresIn = positiveNumber(device.expires_in, DEFAULT_EXPIRES_SECONDS);
  const interval = positiveNumber(device.interval, DEFAULT_POLL_INTERVAL_SECONDS);
  return {
    ...device,
    expires_in: expiresIn,
    interval,
    // The caller may inject now; absent an explicit deadline the polling
    // function computes it from its own clock.
    expiresAt: device.expiresAt !== null && Number.isFinite(Number(device.expiresAt)) ? Number(device.expiresAt) : null,
  };
}

async function requestDeviceCode({
  deviceAuthorizationUrl = XAI_DEVICE_AUTHORIZATION_URL,
  request = defaultRequest,
  clientId = XAI_CLIENT_ID,
  scope = XAI_SCOPE,
  referrer = XAI_REFERRER,
  ...options
} = {}) {
  const body = await callRequest(request, deviceAuthorizationUrl, formRequestOptions({ client_id: clientId, scope, referrer }, options));
  if (typeof body.device_code !== 'string' || !body.device_code) {
    throw oauthError('invalid_response', 'xAI OAuth did not return a device code');
  }
  if (typeof body.user_code !== 'string' || !body.user_code || (typeof body.verification_uri !== 'string' || !body.verification_uri)) {
    throw oauthError('invalid_response', 'xAI OAuth response is missing device_code / user_code / verification_uri');
  }
  return normalizeDevice(body);
}

function tokenError(body) {
  return safeErrorCode(body && body.error);
}

async function pollDeviceCodeToken(device, {
  tokenUrl = XAI_TOKEN_URL,
  request = defaultRequest,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  clientId = XAI_CLIENT_ID,
  safetyMarginMs = DEFAULT_DEVICE_SAFETY_MARGIN_MS,
  ...options
} = {}) {
  const normalized = normalizeDevice(device);
  let interval = Math.max(MIN_POLL_INTERVAL_MS, positiveNumber(normalized.interval, DEFAULT_POLL_INTERVAL_SECONDS) * 1000);
  const startedAt = Number(now());
  const expiresAt = Number.isFinite(Number(normalized.expiresAt)) && normalized.expiresAt !== null
    ? Number(normalized.expiresAt)
    : startedAt + normalized.expires_in * 1000;
  const deadline = expiresAt;
  const safetyMargin = Number.isFinite(Number(safetyMarginMs)) ? Math.max(0, Number(safetyMarginMs)) : DEFAULT_DEVICE_SAFETY_MARGIN_MS;
  let attempts = 0;
  while (Number(now()) < deadline) {
    // This guard prevents a broken injected clock/sleep pair from spinning forever.
    if (++attempts > 10000) throw oauthError('timeout', 'xAI device authorization timed out');
    let body;
    try {
      body = await callRequest(request, tokenUrl, formRequestOptions({
        grant_type: XAI_DEVICE_GRANT_TYPE,
        device_code: normalized.device_code,
        client_id: clientId,
      }, options));
    } catch (error) {
      // OAuth polling errors are useful as codes, but response descriptions can
      // contain credentials, so only expose our sanitized error.
      if (error instanceof XaiOAuthError && ['authorization_pending', 'slow_down', 'access_denied', 'authorization_denied', 'expired_token'].includes(error.code)) {
        if (error.code === 'access_denied' || error.code === 'authorization_denied' || error.code === 'expired_token') throw error;
        if (error.code === 'slow_down') interval += 5000;
        const remaining = deadline - Number(now());
        if (remaining <= 0) break;
        await sleep(Math.max(1, Math.min(interval + safetyMargin, remaining)));
        continue;
      }
      throw error;
    }
    if (typeof body.access_token === 'string' && body.access_token) {
      return body;
    }
    const code = tokenError(body);
    if (code === 'authorization_pending' || code === 'slow_down') {
      if (code === 'slow_down') interval += 5000;
      const remaining = deadline - Number(now());
      if (remaining <= 0) break;
      await sleep(Math.max(1, Math.min(interval, remaining)));
      continue;
    }
    if (code === 'access_denied' || code === 'authorization_denied' || code === 'expired_token') {
      throw oauthError(code, 'xAI device authorization was not approved');
    }
    throw oauthError('invalid_response', 'xAI OAuth token response was invalid');
  }
  throw oauthError('timeout', 'xAI device authorization timed out');
}

function decodeJwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const raw = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - parts[1].length % 4) % 4), 'base64').toString('utf8');
    const claims = JSON.parse(raw);
    return claims && typeof claims === 'object' ? claims : null;
  } catch (_) {
    return null;
  }
}

function tokenExpiry(token) {
  const value = token && typeof token === 'object' ? (token.access || token.access_token || token.token || token) : token;
  const claims = decodeJwtClaims(value);
  if (!claims || !Number.isFinite(Number(claims.exp))) return null;
  return Number(claims.exp) * 1000;
}

function accessTokenIsExpiring(token, skewMs = DEFAULT_EXPIRY_SKEW_MS) {
  if (!token) return true;
  const skew = Math.max(0, Number(skewMs) || 0);
  const value = typeof token === 'object' ? token.access || token.access_token : token;
  if (!value || typeof value !== 'string') return true;
  const storedExpiry = token && typeof token === 'object' ? Number(token.expires) : NaN;
  const jwtExpiry = tokenExpiry(value);
  const expiries = [storedExpiry, jwtExpiry].filter((item) => Number.isFinite(item) && item > 0);
  if (!expiries.length) return false;
  return Math.min(...expiries) <= Date.now() + skew;
}

function normalizeTokenStore(response, previous, now) {
  const access = response && (response.access_token || response.access);
  if (typeof access !== 'string' || !access) throw oauthError('invalid_response', 'xAI OAuth did not return an access token');
  const refresh = response.refresh_token || response.refresh || (previous && (previous.refresh || previous.refresh_token));
  const expiresIn = positiveNumber(response.expires_in, DEFAULT_REFRESH_EXPIRES_SECONDS);
  const claims = decodeJwtClaims(access);
  const jwtExpires = claims && Number.isFinite(Number(claims.exp)) ? Number(claims.exp) * 1000 : null;
  return {
    access,
    refresh: typeof refresh === 'string' && refresh ? refresh : null,
    expires: jwtExpires && jwtExpires > now ? Math.min(now + expiresIn * 1000, jwtExpires) : now + expiresIn * 1000,
    email: claims && typeof claims.email === 'string' ? claims.email : (previous && previous.email) || null,
    scope: response.scope || (previous && previous.scope) || XAI_SCOPE,
    savedAt: now,
  };
}

async function refreshXaiAccess(store, {
  tokenUrl = XAI_TOKEN_URL,
  request = defaultRequest,
  clientId = XAI_CLIENT_ID,
  now = () => Date.now(),
  ...options
} = {}) {
  const refresh = store && (store.refresh || store.refresh_token);
  if (typeof refresh !== 'string' || !refresh) throw oauthError('reauthorization_required', 'xAI OAuth refresh token is unavailable');
  const response = await callRequest(request, tokenUrl, formRequestOptions({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId,
  }, options));
  return normalizeTokenStore(response, store, Number(now()));
}

function defaultOpenBrowser(url, spawnProcess = spawn, platform = process.platform) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const launch = (command, args, fallback) => {
      let attemptSettled = false;
      let child;
      const onError = (error) => {
        if (attemptSettled || settled) return;
        attemptSettled = true;
        if (fallback) launch(fallback.command, fallback.args, null);
        else finish(error);
      };
      const onSpawn = () => {
        if (attemptSettled || settled) return;
        attemptSettled = true;
        try {
          child.unref();
        } catch (error) {
          finish(error);
          return;
        }
        finish();
      };
      try {
        child = spawnProcess(command, args, { detached: true, stdio: 'ignore' });
        if (!child || typeof child.once !== 'function' || typeof child.unref !== 'function') {
          throw new Error('Browser process could not be started');
        }
        child.once('error', onError);
        child.once('spawn', onSpawn);
      } catch (error) {
        onError(error);
      }
    };

    if (platform === 'win32') {
      launch('rundll32', ['url.dll,FileProtocolHandler', url], {
        command: 'explorer',
        args: [url],
      });
    } else {
      const command = platform === 'darwin' ? 'open' : 'xdg-open';
      launch(command, [url], null);
    }
  });
}

function createXaiAuth({
  tokenFile = path.join(os.homedir(), '.zcode', 'gpt-oauth', 'xai-auth.json'),
  endpoints = {},
  openBrowser = defaultOpenBrowser,
  logger = {},
  request = defaultRequest,
  sleep,
  now = () => Date.now(),
  expirySkewMs = DEFAULT_EXPIRY_SKEW_MS,
  ...defaults
} = {}) {
  const urls = { ...DEFAULT_ENDPOINTS, ...endpoints };
  let refreshFlight = null;
  let lastError = null;
  const log = (method, message) => {
    try { if (logger && typeof logger[method] === 'function') logger[method](message); } catch (_) { /* logging must not break auth */ }
  };

  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_) {
      return null;
    }
  }
  function save(store) {
    if (!store || typeof store !== 'object' || typeof store.access !== 'string' || !store.access) {
      throw oauthError('invalid_store', 'xAI OAuth token store is invalid');
    }
    const directory = path.dirname(tokenFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = tokenFile + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    const contents = JSON.stringify(store, null, 2) + '\n';
    try {
      fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, tokenFile);
      fs.chmodSync(tokenFile, 0o600);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) { /* best effort */ }
      throw oauthError('storage_error', 'xAI OAuth token store could not be saved');
    }
    return store;
  }
  function clear() {
    try { fs.unlinkSync(tokenFile); return true; } catch (error) { if (error && error.code === 'ENOENT') return false; throw oauthError('storage_error', 'xAI OAuth token store could not be cleared'); }
  }
  async function doRefresh() {
    const current = load();
    if (!current || !(current.refresh || current.refresh_token)) throw oauthError('reauthorization_required', 'xAI OAuth login is required');
    const updated = await refreshXaiAccess(current, { ...defaults, tokenUrl: urls.tokenUrl, request, now, });
    save(updated);
    lastError = null;
    return updated;
  }
  function refresh() {
    if (!refreshFlight) {
      refreshFlight = doRefresh().catch((error) => { lastError = error.code || 'refresh_failed'; throw error; }).finally(() => { refreshFlight = null; });
    }
    return refreshFlight;
  }
  async function getAccessToken() {
    const current = load();
    if (!current || !current.access) throw oauthError('reauthorization_required', 'xAI OAuth login is required');
    if (!accessTokenIsExpiring(current, expirySkewMs)) return current.access;
    const updated = await refresh();
    return updated.access;
  }
  async function login() {
    const device = await requestDeviceCode({ ...defaults, deviceAuthorizationUrl: urls.deviceAuthorizationUrl, request });
    const verificationUri = device.verification_uri_complete || device.verification_uri;
    if (typeof verificationUri !== 'string' || !verificationUri) throw oauthError('invalid_response', 'xAI OAuth did not return a verification URI');
    let browserLaunchFailed = false;
    try {
      await openBrowser(verificationUri);
    } catch (_) {
      browserLaunchFailed = true;
      log('warn', 'Unable to open xAI verification automatically. Open ' + device.verification_uri + ' and enter code ' + device.user_code + '.');
    }
    log('info', 'xAI verification URL: ' + device.verification_uri + '; user code: ' + device.user_code);
    let response;
    try {
      response = await pollDeviceCodeToken(device, { ...defaults, tokenUrl: urls.tokenUrl, request, ...(sleep ? { sleep } : {}), now });
    } catch (error) {
      if (browserLaunchFailed) {
        // These fields are non-secret instructions a user can follow manually;
        // never copy OAuth response data or tokens onto the login error.
        error.manualUrl = verificationUri;
        error.userCode = device.user_code;
      }
      throw error;
    }
    const store = normalizeTokenStore(response, null, Number(now()));
    save(store);
    lastError = null;
    return { ok: true, userCode: device.user_code, verificationUri, expires: store.expires, ...(store.email ? { email: store.email } : {}) };
  }
  function status() {
    const current = load();
    return {
      loggedIn: Boolean(current && current.access && current.refresh),
      expires: current && Number.isFinite(Number(current.expires)) ? Number(current.expires) : null,
      accessValid: Boolean(current && current.access && !accessTokenIsExpiring(current, expirySkewMs)),
      email: current && typeof current.email === 'string' ? current.email : null,
      lastError,
    };
  }
  return {
    load,
    loadStore: load,
    save,
    saveStore: save,
    clear,
    clearStore: clear,
    login,
    refresh,
    getAccessToken,
    accessToken: getAccessToken,
    status,
  };
}

module.exports = {
  XAI_CLIENT_ID,
  XAI_DEVICE_AUTHORIZATION_URL,
  XAI_TOKEN_URL,
  XAI_DEVICE_GRANT_TYPE,
  XAI_SCOPE,
  XAI_REFERRER,
  XAI_USER_AGENT,
  DEFAULT_ENDPOINTS,
  XaiOAuthError,
  requestDeviceCode,
  pollDeviceCodeToken,
  refreshXaiAccess,
  accessTokenIsExpiring,
  createXaiAuth,
  decodeJwtClaims,
  defaultRequest,
  defaultOpenBrowser,
};
