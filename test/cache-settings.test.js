'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');
function startMcp(home, extra = {}) {
  const child = spawn(process.execPath, [SERVER, '--mcp-only'], { env: { ...process.env, NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, ...extra }, stdio: ['pipe', 'pipe', 'ignore'] });
  let id = 0; const pending = new Map(); let buffer = '';
  child.stdout.on('data', (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const msg = JSON.parse(line); const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); } } catch {} } });
  function call(method, params) { return new Promise((resolve) => { const requestId = ++id; pending.set(requestId, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); }); }
  return { child, call, close: () => child.kill('SIGTERM') };
}
function text(result) { return JSON.parse(result.result.content[0].text); }
function settings(home) { return path.join(home, '.zcode', 'gpt-oauth', 'settings.json'); }
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/healthz' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(500, () => { req.destroy(); resolve(null); });
  });
}
let port8787Before;
test.before(async () => {
  const state = await health(8787);
  port8787Before = { listening: !!state, version: state && state.version };
});
test.after(async () => {
  const state = await health(8787);
  assert.equal(!!state, port8787Before.listening, 'port 8787 listener state changed during cache settings tests');
  assert.equal(state && state.version, port8787Before.version, 'port 8787 daemon version changed during cache settings tests');
});

test('status defaults false and malformed settings do not crash', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-settings-'));
  fs.mkdirSync(path.dirname(settings(home)), { recursive: true });
  fs.writeFileSync(settings(home), '{bad');
  const mcp = startMcp(home);
  try { const r = text(await mcp.call('tools/call', { name: 'gpt_status', arguments: {} })); assert.equal(r.cacheMissNotices, false); } finally { mcp.close(); }
});

test('cache setting preserves unknown keys and auth.json', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-settings-'));
  fs.mkdirSync(path.dirname(settings(home)), { recursive: true });
  const auth = path.join(home, '.zcode', 'gpt-oauth', 'auth.json');
  fs.writeFileSync(auth, '{"refresh":"secret","expires":9999999999999}');
  fs.writeFileSync(settings(home), JSON.stringify({ futureKey: 'kept', cacheMissNotices: false }));
  const before = fs.readFileSync(auth, 'utf8');
  const mcp = startMcp(home);
  try {
    const r = text(await mcp.call('tools/call', { name: 'gpt_cache_miss_notices', arguments: { enabled: true } }));
    assert.equal(r.ok, true); assert.equal(r.cacheMissNotices, true); assert.equal(r.proxyRestarted, false);
    const after = await health(8787);
    assert.equal(!!after, port8787Before.listening);
    assert.equal(after && after.version, port8787Before.version);
  } finally { mcp.close(); }
  const saved = JSON.parse(fs.readFileSync(settings(home), 'utf8'));
  assert.equal(saved.futureKey, 'kept'); assert.equal(saved.cacheMissNotices, true); assert.equal(fs.readFileSync(auth, 'utf8'), before);
  assert.equal(fs.statSync(settings(home)).mode & 0o777, 0o600);
});

test('explicit environment override rejects conflicting request', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-settings-'));
  const mcp = startMcp(home, { GPT_OAUTH_CACHE_MISS_NOTICES: '1' });
  try {
    const response = await mcp.call('tools/call', { name: 'gpt_cache_miss_notices', arguments: { enabled: false } });
    assert.equal(response.result.isError, true); assert.match(response.result.content[0].text, /explicitly overrides/);
  } finally { mcp.close(); }
});
