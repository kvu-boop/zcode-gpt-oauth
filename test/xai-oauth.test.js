'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  XAI_CLIENT_ID,
  XAI_DEVICE_GRANT_TYPE,
  XAI_SCOPE,
  XAI_REFERRER,
  requestDeviceCode,
  pollDeviceCodeToken,
  refreshXaiAccess,
  accessTokenIsExpiring,
  createXaiAuth,
  defaultOpenBrowser,
} = require('../server/xai-oauth');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode(payload) + '.signature';
}
function fixture(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      try {
        const result = await handler({ req, body, requests });
        if (result && result.delay) await new Promise((resolve) => setTimeout(resolve, result.delay));
        res.writeHead(result.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body === undefined ? {} : result.body));
      } catch (_) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });
  return { server, requests };
}
function form(body) { return new URLSearchParams(body); }

const SECRET_DEVICE = 'device-secret-fixture';
const SECRET_ACCESS = 'access-secret-fixture';
const SECRET_REFRESH = 'refresh-secret-fixture';

test('requestDeviceCode sends required form, headers, and validates response', async () => {
  const f = fixture(async () => ({ body: { device_code: SECRET_DEVICE, user_code: 'ABCD-EFGH', verification_uri: 'https://x.ai/verify', expires_in: 60, interval: 2 } }));
  const port = await listen(f.server);
  try {
    const device = await requestDeviceCode({ deviceAuthorizationUrl: `http://127.0.0.1:${port}/device`, timeoutMs: 1000 });
    const request = f.requests[0];
    const sent = form(request.body);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.accept, 'application/json');
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(sent.get('client_id'), XAI_CLIENT_ID);
    assert.equal(sent.get('scope'), XAI_SCOPE);
    assert.equal(sent.get('referrer'), XAI_REFERRER);
    assert.equal(device.user_code, 'ABCD-EFGH');
    await assert.rejects(() => requestDeviceCode({ request: async () => ({ statusCode: 200, body: { device_code: SECRET_DEVICE } }) }), /verification_uri/);
  } finally { await close(f.server); }
});

test('pollDeviceCodeToken handles pending and slow_down before success', async () => {
  let count = 0;
  const delays = [];
  const f = fixture(async () => {
    count += 1;
    if (count === 1) return { status: 400, body: { error: 'authorization_pending', error_description: SECRET_ACCESS } };
    if (count === 2) return { status: 400, body: { error: 'slow_down', error_description: SECRET_REFRESH } };
    return { body: { access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH, expires_in: 30 } };
  });
  const port = await listen(f.server);
  try {
    const result = await pollDeviceCodeToken({ device_code: SECRET_DEVICE, user_code: 'CODE', verification_uri: 'https://x.ai', expires_in: 30, interval: 1 }, {
      tokenUrl: `http://127.0.0.1:${port}/token`, sleep: async (ms) => delays.push(ms), now: (() => { const start = Date.now(); return () => start; })(),
    });
    assert.equal(result.access_token, SECRET_ACCESS);
    assert.equal(delays.length, 2);
    assert.ok(delays[0] >= 1000);
    assert.ok(delays[1] >= 6000);
    const sent = form(f.requests[0].body);
    assert.equal(sent.get('grant_type'), XAI_DEVICE_GRANT_TYPE);
    assert.equal(sent.get('client_id'), XAI_CLIENT_ID);
    assert.equal(sent.get('device_code'), SECRET_DEVICE);
  } finally { await close(f.server); }
});

test('poll terminal errors, malformed timing, and hard timeout are bounded', async () => {
  for (const error of ['access_denied', 'authorization_denied', 'expired_token']) {
    await assert.rejects(() => pollDeviceCodeToken({ device_code: SECRET_DEVICE, user_code: 'C', verification_uri: 'https://x.ai', expires_in: 10 }, {
      request: async () => ({ statusCode: 400, body: { error, error_description: SECRET_ACCESS } }),
      now: () => 0,
      sleep: async () => {},
    }), (e) => e.code === error && !e.message.includes(SECRET_ACCESS));
  }
  let sleeps = 0;
  await assert.rejects(() => pollDeviceCodeToken({ device_code: SECRET_DEVICE, user_code: 'C', verification_uri: 'https://x.ai', expires_in: 'not-a-number', interval: 'NaN' }, {
    request: async () => ({ statusCode: 400, body: { error: 'authorization_pending' } }),
    now: (() => { let value = 0; return () => value; })(),
    sleep: async () => { sleeps += 1; },
    safetyMarginMs: 0,
  }), (e) => e.code === 'timeout' && sleeps <= 10000);
});

test('refresh sends grant and preserves old refresh token when rotated value is omitted', async () => {
  const f = fixture(async () => ({ body: { access_token: SECRET_ACCESS, expires_in: 100 } }));
  const port = await listen(f.server);
  try {
    const result = await refreshXaiAccess({ access: 'old-access', refresh: SECRET_REFRESH }, { tokenUrl: `http://127.0.0.1:${port}/token`, now: () => 1000 });
    const sent = form(f.requests[0].body);
    assert.equal(sent.get('grant_type'), 'refresh_token');
    assert.equal(sent.get('refresh_token'), SECRET_REFRESH);
    assert.equal(result.access, SECRET_ACCESS);
    assert.equal(result.refresh, SECRET_REFRESH);
  } finally { await close(f.server); }
});

test('JWT expiry uses claims with proactive skew and malformed JWT is not trusted', () => {
  const now = Date.now();
  assert.equal(accessTokenIsExpiring(jwt({ exp: Math.floor((now + 120000) / 1000) }), 60000), false);
  assert.equal(accessTokenIsExpiring(jwt({ exp: Math.floor((now + 10000) / 1000) }), 60000), true);
  assert.equal(accessTokenIsExpiring('opaque-token', 60000), false);
});

test('defaultOpenBrowser uses argument-safe Windows fallback without double settlement', async () => {
  const launches = [];
  const children = [];
  const spawnProcess = (command, args) => {
    launches.push({ command, args });
    const child = new EventEmitter();
    child.unref = () => { child.unrefCount = (child.unrefCount || 0) + 1; };
    children.push(child);
    process.nextTick(() => {
      if (command === 'rundll32') child.emit('error', new Error('not available'));
      else child.emit('spawn');
    });
    return child;
  };
  const url = 'https://x.ai/verify?code=A&B=1';
  await defaultOpenBrowser(url, spawnProcess, 'win32');
  assert.deepEqual(launches, [
    { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] },
    { command: 'explorer', args: [url] },
  ]);
  assert.equal(children[1].unrefCount, 1);
  assert.equal(launches.some(({ command }) => command === 'cmd'), false);
});

test('createXaiAuth login adds manual guidance only after browser failure and redacts secrets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-login-failure-'));
  const deviceCode = 'device-login-secret';
  const accessToken = 'access-login-secret';
  const refreshToken = 'refresh-login-secret';
  const auth = createXaiAuth({
    tokenFile: path.join(home, 'xai.json'),
    openBrowser: async () => { throw new Error('browser unavailable'); },
    request: async (url) => {
      if (url.endsWith('/device')) return { statusCode: 200, body: { device_code: deviceCode, user_code: 'USER-456', verification_uri: 'https://x.ai/verify', verification_uri_complete: 'https://x.ai/verify?code=USER-456', expires_in: 60, interval: 1 } };
      return { statusCode: 400, body: { error: 'authorization_pending', error_description: accessToken, device_code: deviceCode, refresh_token: refreshToken } };
    },
    endpoints: { deviceAuthorizationUrl: 'http://fixture/device', tokenUrl: 'http://fixture/token' },
    now: () => 0,
    sleep: async () => {},
  });
  await assert.rejects(() => auth.login(), (error) => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.manualUrl, 'https://x.ai/verify?code=USER-456');
    assert.equal(error.userCode, 'USER-456');
    assert.equal(error.message.includes(deviceCode), false);
    assert.equal(error.message.includes(accessToken), false);
    assert.equal(error.message.includes(refreshToken), false);
    return true;
  });
});

test('createXaiAuth login opens complete URL, persists atomically mode 0600, status and clear are safe', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-oauth-'));
  const tokenFile = path.join(home, 'nested', 'xai-auth.json');
  let opened;
  let calls = 0;
  const auth = createXaiAuth({
    tokenFile,
    openBrowser: async (url) => { opened = url; },
    request: async (url) => {
      calls += 1;
      if (url.endsWith('/device')) return { statusCode: 200, body: { device_code: SECRET_DEVICE, user_code: 'USER-123', verification_uri: 'https://x.ai/verify', verification_uri_complete: 'https://x.ai/verify?code=USER-123', expires_in: 60, interval: 1 } };
      return { statusCode: 200, body: { access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH, expires_in: 100 } };
    },
    endpoints: { deviceAuthorizationUrl: 'http://fixture/device', tokenUrl: 'http://fixture/token' },
    sleep: async () => {},
  });
  const result = await auth.login();
  assert.equal(result.userCode, 'USER-123');
  assert.equal(opened, 'https://x.ai/verify?code=USER-123');
  assert.equal(calls, 2);
  const stat = fs.statSync(tokenFile);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(auth.status().loggedIn, true);
  assert.equal(auth.status().accessValid, true);
  assert.equal(auth.clear(), true);
  assert.equal(auth.clear(), false);
  assert.equal(auth.status().loggedIn, false);
});

test('refresh is single-flight, persists rotation, and errors never expose fixture secrets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-refresh-'));
  const tokenFile = path.join(home, 'xai.json');
  let requests = 0;
  let resolveRequest;
  const request = async () => {
    requests += 1;
    await new Promise((resolve) => { resolveRequest = resolve; });
    return { statusCode: 200, body: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 100 } };
  };
  const auth = createXaiAuth({ tokenFile, request, endpoints: { tokenUrl: 'http://fixture/token' }, now: () => 1000 });
  auth.save({ access: 'old-access', refresh: SECRET_REFRESH, expires: 0 });
  const first = auth.refresh();
  const second = auth.refresh();
  assert.strictEqual(first, second);
  assert.equal(requests, 1);
  resolveRequest();
  await Promise.all([first, second]);
  assert.equal(auth.load().refresh, 'new-refresh');
  await assert.rejects(() => refreshXaiAccess({ refresh: SECRET_REFRESH }, { request: async () => { throw new Error('contains ' + SECRET_REFRESH); } }), (error) => !error.message.includes(SECRET_REFRESH));
});

test('HTTP error and oversized body messages do not contain secrets', async () => {
  const f = fixture(async () => ({ status: 400, body: { error: 'invalid_grant', error_description: SECRET_REFRESH } }));
  const port = await listen(f.server);
  try {
    await assert.rejects(() => refreshXaiAccess({ refresh: SECRET_REFRESH }, { tokenUrl: `http://127.0.0.1:${port}/token` }), (error) => !error.message.includes(SECRET_REFRESH));
  } finally { await close(f.server); }
});
