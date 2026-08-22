'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
    assert.equal(r.ok, true); assert.equal(r.cacheMissNotices, true);
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
