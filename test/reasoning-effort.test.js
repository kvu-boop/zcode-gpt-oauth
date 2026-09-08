'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function getModels(port) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/v1/models' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

// Upstream fixture: captures every request body and replies with a minimal
// valid SSE stream so the proxy completes both streaming and non-streaming
// requests (same event shapes the proxy transforms in cache-integration.test.js).
function upstreamFixture() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      requests.push(JSON.parse(b));
      const events = [
        { type: 'response.output_text.delta', delta: 'hello' },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of events) res.write('data: ' + JSON.stringify(e) + '\r\n\r\n');
      res.end('data: [DONE]\r\n\r\n');
    });
  });
  return { server, requests };
}

let fixture, backendPort, proxy;

test.before(async () => {
  fixture = upstreamFixture();
  backendPort = await listen(fixture.server);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-effort-'));
  fs.mkdirSync(path.join(home, '.zcode', 'gpt-oauth'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zcode', 'gpt-oauth', 'auth.json'), JSON.stringify({ access: 'fixture', refresh: 'fixture', expires: Date.now() + 3600000 }));
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const child = spawn(process.execPath, [SERVER, '--http-only'], {
    env: { ...process.env, NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_PROXY_PORT: String(port), GPT_OAUTH_BACKEND_BASE: 'http://127.0.0.1:' + backendPort },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proxy = {
    child, port,
    ready: new Promise((resolve, reject) => {
      let s = '';
      const t = setTimeout(() => reject(new Error('proxy start timeout: ' + s)), 5000);
      child.stderr.on('data', (d) => { s += d; if (s.includes('Proxy listening')) { clearTimeout(t); resolve(port); } });
      child.on('exit', (c) => { if (c) reject(new Error('proxy exited ' + c)); });
    }),
  };
  proxy.port = await proxy.ready;
});

test.after(() => {
  proxy.child.kill('SIGTERM');
  fixture.server.close();
});

test('valid reasoning_effort is forwarded as reasoning + include to the backend', async () => {
  const r = await post(proxy.port, JSON.stringify({ model: 'gpt-6-astra', reasoning_effort: 'high', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(r.status, 200);
  const upstream = fixture.requests.at(-1);
  assert.equal(upstream.model, 'gpt-6-astra');
  assert.deepEqual(upstream.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(upstream.include, ['reasoning.encrypted_content']);
});

test('legacy/invalid reasoning_effort is dropped from the backend body', async () => {
  const r = await post(proxy.port, JSON.stringify({ model: 'gpt-6-astra', reasoning_effort: 'minimal', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(r.status, 200);
  const upstream = fixture.requests.at(-1);
  assert.equal('reasoning' in upstream, false);
  assert.equal('include' in upstream, false);
});

test('no reasoning_effort keeps the pre-astra wire format', async () => {
  const r = await post(proxy.port, JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(r.status, 200);
  const upstream = fixture.requests.at(-1);
  assert.equal('reasoning' in upstream, false);
  assert.equal('include' in upstream, false);
});

test('models list contains gpt-6-astra and the gpt-5.6 family', async () => {
  const r = await getModels(proxy.port);
  assert.equal(r.status, 200);
  const ids = JSON.parse(r.body).data.map((m) => m.id);
  assert.ok(ids.includes('gpt-6-astra'));
  assert.ok(ids.includes('gpt-5.6-sol'));
  assert.ok(ids.includes('gpt-5.6-terra'));
  assert.ok(ids.includes('gpt-5.6-luna'));
});
