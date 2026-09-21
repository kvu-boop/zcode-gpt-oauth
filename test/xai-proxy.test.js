'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); }); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(payload);
  });
}
function startProxy(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/server.js'), '--http-only'], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.includes('Proxy listening')) resolve(child);
    });
    child.once('error', reject);
    child.once('exit', (code) => { if (code && !stderr.includes('Proxy listening')) reject(new Error(stderr || `proxy exited ${code}`)); });
  });
}
function stop(child) { return new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); }); }
function netServer() { return require('node:net').createServer(); }
function writeToken(home, access = 'fixture-access') {
  const dir = path.join(home, '.zcode', 'gpt-oauth');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'xai-auth.json'), JSON.stringify({ access, refresh: 'fixture-refresh', expires: Date.now() + 3600000, email: 'x@example.test' }));
  return path.join(dir, 'xai-auth.json');
}

const GROK = 'grok-4.6';

test('xAI proxy routes explicitly, unions models, passes through JSON/SSE/tools, and refreshes once', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-proxy-'));
  const apiRequests = [];
  let xaiCalls = 0;
  const api = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; }); req.on('end', () => {
      apiRequests.push({ url: req.url, headers: req.headers, body: data });
      if (req.url === '/oauth2/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }));
      }
      if (req.url === '/v1/models') return res.end(JSON.stringify({ object: 'list', data: [{ id: GROK }] }));
      if (req.url === '/v1/chat/completions') {
        xaiCalls++;
        if (xaiCalls === 1) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'expired' } })); }
        const parsed = JSON.parse(data);
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"id":"fixture","choices":[{"delta":{"role":"assistant"}}]}\n\n');
          return setTimeout(() => { res.end('data: {"id":"fixture","choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'); }, 5);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls' }] }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  const apiPort = await listen(api);
  const proxyPort = await new Promise((resolve) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const xaiFile = writeToken(home, 'old-access');
  fs.writeFileSync(path.join(home, '.zcode', 'gpt-oauth', 'auth.json'), JSON.stringify({ access: 'gpt-access', refresh: 'gpt-refresh', expires: Date.now() + 3600000 }));
  const backend = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { assert.equal(req.url, '/responses'); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"response.output_text.delta","delta":"gpt"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'); }); });
  const backendPort = await listen(backend);
  const child = await startProxy({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_PROXY_PORT: String(proxyPort), GPT_OAUTH_BACKEND_BASE: `http://127.0.0.1:${backendPort}`, XAI_OAUTH_API_BASE: `http://127.0.0.1:${apiPort}/v1`, XAI_OAUTH_TOKEN_URL: `http://127.0.0.1:${apiPort}/oauth2/token` });
  t.after(async () => { await stop(child); await close(api); await close(backend); });

  const models = await request(proxyPort, 'GET', '/v1/models');
  assert.equal(models.status, 200);
  const ids = JSON.parse(models.body).data.map((m) => m.id);
  assert.ok(ids.includes('gpt-6-astra')); assert.ok(ids.includes(GROK)); assert.equal(ids.length, 10);
  const health = JSON.parse((await request(proxyPort, 'GET', '/healthz')).body);
  assert.deepEqual(health.providers, { openai: { loggedIn: true }, xai: { loggedIn: true } });
  assert.equal(health.modelCount, 10);

  const unknown = await request(proxyPort, 'POST', '/v1/chat/completions', { model: 'unknown', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(unknown.status, 404);
  const xai = await request(proxyPort, 'POST', '/v1/chat/completions', { model: GROK, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }, { authorization: 'Bearer client-secret' });
  assert.equal(xai.status, 200, xai.body);
  assert.match(xai.body, /tool_calls/);
  const chatRequests = apiRequests.filter((entry) => entry.url === '/v1/chat/completions');
  assert.equal(chatRequests[0].headers.authorization, 'Bearer old-access');
  assert.equal(chatRequests[1].headers.authorization, 'Bearer new-access');
  assert.equal(JSON.parse(fs.readFileSync(xaiFile)).access, 'new-access', 'refresh fixture should persist rotated access');
  assert.equal(JSON.parse(chatRequests[0].body).tools[0].function.name, 'lookup');

  const stream = await request(proxyPort, 'POST', '/v1/chat/completions', { model: GROK, stream: true, messages: [{ role: 'user', content: 'stream' }] });
  assert.equal(stream.status, 200); assert.match(stream.body, /data: \[DONE\]/); assert.match(stream.body, /hello/);
  const gpt = await request(proxyPort, 'POST', '/v1/chat/completions', { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'gpt' }] });
  assert.equal(gpt.status, 200); assert.match(gpt.body, /chat.completion/);
  assert.equal(apiRequests.filter((x) => x.url === '/v1/chat/completions').length, 3);
});

test('xAI heartbeat uses real SSE newlines while stream remains open', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-proxy-heartbeat-'));
  writeToken(home);
  const api = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"fixture","choices":[{"delta":{"role":"assistant"}}]}\\n\\n');
      setTimeout(() => res.end('data: [DONE]\\n\\n'), 90);
    });
  });
  const apiPort = await listen(api);
  const proxyPort = await new Promise((resolve) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = await startProxy({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_PROXY_PORT: String(proxyPort), XAI_OAUTH_API_BASE: `http://127.0.0.1:${apiPort}/v1`, GPT_OAUTH_STREAM_HEARTBEAT_MS: '20', GPT_OAUTH_STREAM_IDLE_TIMEOUT_MS: '300' });
  t.after(async () => { await stop(child); await close(api); });
  const stream = await request(proxyPort, 'POST', '/v1/chat/completions', { model: GROK, stream: true, messages: [{ role: 'user', content: 'heartbeat' }] });
  assert.equal(stream.status, 200);
  assert.match(stream.body, /: keep-alive\n\n/);
  assert.doesNotMatch(stream.body, /: keep-alive\\\\n\\\\n/);
});

test('xAI stream reuses one idle timer across a long active stream', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-proxy-idle-refresh-'));
  writeToken(home);
  const newline = String.fromCharCode(10);
  const api = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"active","choices":[{"delta":{"content":"a"}}]}' + newline + newline);
      let count = 0;
      const timer = setInterval(() => {
        count++;
        if (count < 6) return res.write('data: {"id":"active","choices":[{"delta":{"content":"a"}}]}' + newline + newline);
        clearInterval(timer);
        res.end('data: [DONE]' + newline + newline);
      }, 15);
    });
  });
  const apiPort = await listen(api);
  const proxyPort = await new Promise((resolve) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = await startProxy({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_PROXY_PORT: String(proxyPort), XAI_OAUTH_API_BASE: `http://127.0.0.1:${apiPort}/v1`, GPT_OAUTH_STREAM_IDLE_TIMEOUT_MS: '40', GPT_OAUTH_STREAM_HEARTBEAT_MS: '200' });
  t.after(async () => { await stop(child); await close(api); });
  const stream = await request(proxyPort, 'POST', '/v1/chat/completions', { model: GROK, stream: true, messages: [{ role: 'user', content: 'active' }] });
  assert.equal(stream.status, 200);
  assert.match(stream.body, /data: \[DONE\]/);
  assert.doesNotMatch(stream.body, /xAI upstream idle timeout/);
});

test('xAI stream failure after SSE headers uses valid error framing', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-proxy-post-header-error-'));
  writeToken(home);
  const newline = String.fromCharCode(10);
  const api = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"stall","choices":[{"delta":{"role":"assistant"}}]}' + newline + newline);
      setTimeout(() => res.end(), 100);
    });
  });
  const apiPort = await listen(api);
  const proxyPort = await new Promise((resolve) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = await startProxy({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_PROXY_PORT: String(proxyPort), XAI_OAUTH_API_BASE: `http://127.0.0.1:${apiPort}/v1`, GPT_OAUTH_STREAM_IDLE_TIMEOUT_MS: '35', GPT_OAUTH_STREAM_HEARTBEAT_MS: '200' });
  t.after(async () => { await stop(child); await close(api); });
  const stream = await request(proxyPort, 'POST', '/v1/chat/completions', { model: GROK, stream: true, messages: [{ role: 'user', content: 'stall' }] });
  assert.equal(stream.status, 200);
  assert.match(stream.body, /data: \{"error"/);
  assert.match(stream.body, /data: \[DONE\]\n\n/);
  assert.doesNotMatch(stream.body, /\\\\n\\\\n/);
});

test('xAI stream returns bounded JSON for non-2xx and JSON for header timeout', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-proxy-errors-'));
  writeToken(home);
  let mode = 'error';
  const api = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') return res.end('{}');
    req.resume();
    req.on('end', () => {
      if (mode === 'timeout') return;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }) + 'x'.repeat(100000));
    });
  });
  const apiPort = await listen(api);
  const proxyPort = await new Promise((resolve) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = await startProxy({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_PROXY_PORT: String(proxyPort), XAI_OAUTH_API_BASE: `http://127.0.0.1:${apiPort}/v1`, GPT_OAUTH_STREAM_HEADERS_TIMEOUT_MS: '40', GPT_OAUTH_STREAM_IDLE_TIMEOUT_MS: '200' });
  t.after(async () => { await stop(child); await close(api); });
  const error = await request(proxyPort, 'POST', '/v1/chat/completions', { model: GROK, stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(error.status, 429);
  assert.doesNotMatch(error.body, /^data:/m);
  assert.equal(JSON.parse(error.body).error.type, 'gpt_oauth_error');
  assert.ok(error.body.length < 1000, 'error response should stay bounded');
  mode = 'timeout';
  const timeout = await request(proxyPort, 'POST', '/v1/chat/completions', { model: GROK, stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(timeout.status, 504);
  assert.equal(JSON.parse(timeout.body).error.type, 'gpt_oauth_error');
});

test('xAI non-stream oversized upstream errors stay bounded', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-proxy-nonstream-error-'));
  writeToken(home);
  const api = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream failure' } }) + 'x'.repeat(20 * 1024 * 1024));
    });
  });
  const apiPort = await listen(api);
  const proxyPort = await new Promise((resolve) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = await startProxy({ NODE_ENV: 'test', HOME: home, GPT_OAUTH_HOME: home, GPT_OAUTH_PROXY_PORT: String(proxyPort), XAI_OAUTH_API_BASE: `http://127.0.0.1:${apiPort}/v1`, GPT_OAUTH_STREAM_IDLE_TIMEOUT_MS: '1000' });
  t.after(async () => { await stop(child); await close(api); });
  const result = await request(proxyPort, 'POST', '/v1/chat/completions', { model: GROK, messages: [{ role: 'user', content: 'error' }] });
  assert.equal(result.status, 500);
  assert.ok(result.body.length < 1000, 'local error response should stay bounded');
  assert.equal(JSON.parse(result.body).error.type, 'gpt_oauth_error');
});
