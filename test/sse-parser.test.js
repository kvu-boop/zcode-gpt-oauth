'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSSEParser } = require('../server/server.js');

function parseInto(body, chunkSizes) {
  const events = [];
  let done = 0;
  const errors = [];
  const parser = createSSEParser((ev) => events.push(ev), () => { done++; }, (err) => errors.push(err));
  if (!chunkSizes) {
    parser.push(body);
  } else {
    let at = 0;
    for (const size of chunkSizes) { parser.push(body.slice(at, at + size)); at += size; }
  }
  parser.flush();
  return { events, done, errors };
}
function oneByteSizes(len) { const sizes = []; for (let i = 0; i < len; i++) sizes.push(1); return sizes; }

test('chunk-split feeding yields the same events as feeding whole', () => {
  const body = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';
  const expected = [{ a: 1 }, { b: 2 }];
  const whole = parseInto(body);
  assert.deepEqual(whole.events, expected);
  assert.equal(whole.done, 0);
  assert.deepEqual(whole.errors, []);
  assert.deepEqual(parseInto(body, oneByteSizes(body.length)).events, expected);
});

test('CRLF split mid-sequence and mid-separator still parse', () => {
  const expected = [{ a: 1 }, { b: 2 }];
  const midCrlf = 'data: {"a":1}\r' + '\n\r\ndata: {"b":2}\r\n\r\n';   // split inside first CRLF
  assert.deepEqual(parseInto(midCrlf).events, expected);
  const midSep = 'data: {"a":1}\r\n\r' + '\ndata: {"b":2}\r\n\r\n';   // split inside the blank-line CRLF
  assert.deepEqual(parseInto(midSep).events, expected);
});

test('CR-only line endings and multi-line data fields match the LF version', () => {
  const lf = 'data: {"a":1,\ndata: "b":"b"}\n\n';
  const cr = 'data: {"a":1,\rdata: "b":"b"}\r\r';
  const crlf = 'data: {"a":1,\r\ndata: "b":"b"}\r\n\r\n';
  const expected = [{ a: 1, b: 'b' }];
  assert.deepEqual(parseInto(lf).events, expected);
  assert.deepEqual(parseInto(cr).events, expected);
  assert.deepEqual(parseInto(cr, oneByteSizes(cr.length)).events, expected);
  assert.deepEqual(parseInto(crlf).events, expected);
});

test('[DONE] fires onDone', () => {
  const r = parseInto('data: [DONE]\n\n');
  assert.equal(r.done, 1);
  assert.deepEqual(r.events, []);
  const mixed = parseInto('data: {"a":1}\n\ndata: [DONE]\n\n');
  assert.equal(mixed.done, 1);
  assert.deepEqual(mixed.events, [{ a: 1 }]);
});

test('comment and blank lines are ignored', () => {
  const r = parseInto(': keep-alive\n\ndata: {"a":1}\n\n');
  assert.deepEqual(r.events, [{ a: 1 }]);
});

test('flush emits a trailing unterminated event, including one ending in CR', () => {
  assert.deepEqual(parseInto('data: {"c":3}').events, [{ c: 3 }]);
  assert.deepEqual(parseInto('data: {"c":3}\r').events, [{ c: 3 }]);
});

test('oversized event fires onError once and dead-ignores later pushes', () => {
  const big = 'data: "' + 'x'.repeat(70 * 1024 * 1024) + '"';
  const events = [];
  const errors = [];
  let done = 0;
  const parser = createSSEParser((ev) => events.push(ev), () => { done++; }, (err) => errors.push(err));
  const MB = 1024 * 1024;
  for (let i = 0; i < big.length; i += MB) parser.push(big.slice(i, i + MB));
  parser.flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'upstream SSE event exceeded ' + (64 * 1024 * 1024) + ' bytes');
  assert.equal(done, 0);
  assert.equal(events.length, 0);
  parser.push('data: {"z":1}\n\n'); // dead state: ignored
  parser.flush();
  assert.equal(events.length, 0);
  assert.equal(errors.length, 1);
});

test('32MB single event parses in linear time (guard: under 5s)', () => {
  const event = 'data: "' + 'y'.repeat(32 * 1024 * 1024) + '"\n\n';
  const events = [];
  const parser = createSSEParser((ev) => events.push(ev));
  const start = Date.now();
  const CH = 64 * 1024;
  for (let i = 0; i < event.length; i += CH) parser.push(event.slice(i, i + CH));
  parser.flush();
  const elapsed = Date.now() - start;
  assert.equal(events.length, 1);
  assert.equal(typeof events[0], 'string');
  assert.equal(events[0].length, 32 * 1024 * 1024);
  assert.ok(elapsed < 5000, 'parse took ' + elapsed + 'ms');
});