'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const BODY_CAP = '1000'; // tiny cap via GPT_OAUTH_MAX_BODY_BYTES so the test stays fast

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
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/healthz' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(500, () => { req.destroy(); resolve(null); });
  });
}

let fixture, backendPort, proxy;
const BIG_BODY = JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x'.repeat(2000) }] });
const SMALL_BODY = JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] });

test.before(async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  backendPort = await listen(upstream);
  fixture = { upstream, upstreamCalls: () => upstreamCalls };

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-body-'));
  fs.mkdirSync(path.join(home, '.zcode', 'gpt-oauth'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zcode', 'gpt-oauth', 'auth.json'), JSON.stringify({ access: 'fixture', refresh: 'fixture', expires: Date.now() + 3600000 }));
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const child = spawn(process.execPath, [SERVER, '--http-only'], {
    env: { ...process.env, NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_PROXY_PORT: String(port), GPT_OAUTH_BACKEND_BASE: 'http://127.0.0.1:' + backendPort, GPT_OAUTH_MAX_BODY_BYTES: BODY_CAP },
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
  fixture.upstream.close();
});

test('oversized request body destroys the connection without reaching upstream', async () => {
  await assert.rejects(post(proxy.port, BIG_BODY));
  assert.equal(fixture.upstreamCalls(), 0);
});

test('small bodies still flow through the request handler', async () => {
  const bad = await post(proxy.port, '{bad');
  assert.equal(bad.status, 400);
  assert.match(bad.body, /invalid JSON body/);
  const ok = await post(proxy.port, SMALL_BODY);
  assert.equal(fixture.upstreamCalls(), 1);
  assert.ok(ok.status === 200 || ok.status === 502, 'expected 200 or 502, got ' + ok.status);
});

test('MCP-only process with watchdog env stays alive and leaves port 8787 untouched (NODE_ENV=test)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-watchdog-'));
  const before = await health(8787);
  const client = spawn(process.execPath, [SERVER, '--mcp-only'], {
    env: { ...process.env, NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_DAEMON_WATCHDOG_MS: '50' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let exited = false;
  client.on('exit', () => { exited = true; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(exited, false, 'MCP-only child exited unexpectedly');
  client.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 100));
  const after = await health(8787);
  assert.equal(!!after, !!before, 'port 8787 listener state changed');
});