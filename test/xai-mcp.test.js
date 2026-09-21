'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
function launch(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/server.js'), '--mcp-only'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (!line) continue;
      const msg = JSON.parse(line); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  function call(method, params) {
    const requestId = ++id;
    return new Promise((resolve, reject) => { pending.set(requestId, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) }) + '\n'); setTimeout(() => { if (pending.delete(requestId)) reject(new Error('MCP timeout')); }, 10000); });
  }
  return { child, call };
}
function stop(child) { return new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); }); }
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/healthz' }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.setTimeout(500, () => { req.destroy(); resolve(null); });
  });
}

let port8787Before;
test.before(async () => {
  const state = await health(8787);
  port8787Before = { listening: !!state, version: state && state.version };
});
test.after(async () => {
  const state = await health(8787);
  assert.equal(!!state, port8787Before.listening, 'port 8787 listener state changed during xAI MCP tests');
  assert.equal(state && state.version, port8787Before.version, 'port 8787 daemon version changed during xAI MCP tests');
});

test('mcp-only exposes xAI tools and does not bind production port', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-mcp-'));
  const tokenDir = path.join(home, '.zcode', 'gpt-oauth'); fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'xai-auth.json'), JSON.stringify({ access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000, email: 'grok@example.test' }));
  const mcp = launch({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_DAEMON_WATCHDOG_MS: '0' });
  t.after(() => stop(mcp.child));
  const list = await mcp.call('tools/list');
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('xai_login')); assert.ok(names.includes('xai_logout')); assert.ok(names.includes('xai_status')); assert.ok(names.includes('gpt_status'));
  const status = await mcp.call('tools/call', { name: 'xai_status', arguments: {} });
  const statusValue = JSON.parse(status.result.content[0].text);
  assert.equal(statusValue.loggedIn, true); assert.equal(statusValue.email, 'grok@example.test'); assert.equal(statusValue.proxyRunning, port8787Before.listening); assert.doesNotMatch(JSON.stringify(statusValue), /fixture-access|fixture-refresh/);
  const logout = await mcp.call('tools/call', { name: 'xai_logout', arguments: {} });
  assert.deepEqual(JSON.parse(logout.result.content[0].text), { ok: true, wasLoggedIn: true });
  const after = await mcp.call('tools/call', { name: 'xai_status', arguments: {} });
  assert.equal(JSON.parse(after.result.content[0].text).loggedIn, false);
});

test('xai_login succeeds with local fixtures, saves token, and opens no real browser', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-mcp-login-success-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-browser-'));
  const open = path.join(bin, 'open');
  fs.writeFileSync(open, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/device') return res.end(JSON.stringify({ device_code: 'device-fixture', user_code: 'CODE-1234', verification_uri: 'https://example.test/verify', expires_in: 60, interval: 1 }));
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'saved-access', refresh_token: 'saved-refresh', expires_in: 3600 }));
    res.writeHead(404); return res.end('{}');
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = fixture.address().port;
  const before = await health(8787);
  const mcp = launch({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, PATH: bin + path.delimiter + process.env.PATH, XAI_OAUTH_DEVICE_URL: `http://127.0.0.1:${port}/device`, XAI_OAUTH_TOKEN_URL: `http://127.0.0.1:${port}/token` });
  t.after(async () => { await stop(mcp.child); await new Promise((resolve) => fixture.close(resolve)); });
  const result = await mcp.call('tools/call', { name: 'xai_login', arguments: {} });
  const login = JSON.parse(result.result.content[0].text);
  assert.equal(login.ok, true);
  assert.equal(login.userCode, 'CODE-1234');
  assert.doesNotMatch(JSON.stringify(login), /saved-access|saved-refresh/);
  const tokenFile = path.join(home, '.zcode', 'gpt-oauth', 'xai-auth.json');
  const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  assert.equal(saved.access, 'saved-access'); assert.equal(saved.refresh, 'saved-refresh');
  const status = JSON.parse((await mcp.call('tools/call', { name: 'xai_status', arguments: {} })).result.content[0].text);
  assert.equal(status.loggedIn, true); assert.doesNotMatch(JSON.stringify(status), /saved-access|saved-refresh/);
  const after = await health(8787);
  assert.equal(!!after, !!before);
  assert.equal(after && after.version, before && before.version);
});

test('xai_login errors are safe and include manual guidance', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-mcp-login-'));
  const fixture = require('node:http').createServer((req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'access_denied', error_description: 'fixture-secret-access' })); });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = fixture.address().port;
  const mcp = launch({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, XAI_OAUTH_DEVICE_URL: `http://127.0.0.1:${port}/device`, XAI_OAUTH_TOKEN_URL: `http://127.0.0.1:${port}/token` });
  t.after(async () => { await stop(mcp.child); fixture.close(); });
  const result = await mcp.call('tools/call', { name: 'xai_login', arguments: {} });
  const text = result.result.content[0].text;
  assert.match(text, /xai_login failed/); assert.match(text, /verification URL|browser/); assert.doesNotMatch(text, /fixture-secret-access/); assert.doesNotMatch(text, /access_token|refresh_token/);
});
