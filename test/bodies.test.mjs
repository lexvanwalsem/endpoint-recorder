import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, createStore, flatten, formatBytes, looksBinary, normalizeMime, parseBody, toMarkdown } from '../recorder.mjs';

test('form-encoded request bodies become fields', () => {
  const store = createStore();
  addEntry(store, {
    method: 'POST', url: 'https://a.example/login', status: 200, timeMs: 5,
    reqText: 'user=bob&tag=a&tag=b', reqMime: 'application/x-www-form-urlencoded; charset=UTF-8',
    resText: '{"ok":true}', resMime: 'application/json',
  });
  const ep = Object.values(store.endpoints)[0];
  const rows = Object.fromEntries(flatten(ep.req).map((r) => [r.path, r.types]));
  assert.deepEqual(rows['$.user'], ['string']);
  assert.deepEqual(rows['$.tag'], ['array']);
  assert.deepEqual(ep.reqTypes, { 'application/x-www-form-urlencoded': 1 });
});

test('html is kept as a text sample, binary and skipped calls are noted, sizes are summed', () => {
  const store = createStore();
  const base = { method: 'GET', url: 'https://a.example/page', status: 200, timeMs: 5 };
  addEntry(store, { ...base, resText: '<html><body>Hello</body></html>', resMime: 'text/html; charset=utf-8', size: 2048, type: 'Document' }, { keepExamples: true });
  addEntry(store, { ...base, url: 'https://a.example/file.pdf', resMime: 'application/pdf', binary: true, size: 4096, type: 'Other' }, { keepExamples: true });
  addEntry(store, { ...base, url: 'https://a.example/huge', resMime: 'application/json', skipped: 'too large', size: 60_000_000, type: 'Fetch' }, { keepExamples: true });
  const eps = Object.fromEntries(Object.values(store.endpoints).map((e) => [e.path, e]));
  assert.equal(eps['/page'].samples[0].resText, '<html><body>Hello</body></html>');
  assert.equal(eps['/page'].res, null); // text has no fields
  assert.deepEqual(eps['/page'].resTypes, { 'text/html': 1 });
  assert.equal(eps['/page'].sizeMax, 2048);
  assert.equal(eps['/file.pdf'].samples[0].binary, true);
  assert.equal(eps['/huge'].samples[0].skipped, 'too large');
  const md = toMarkdown(store);
  assert.match(md, /Response \(text\)/);
  assert.match(md, /Response is binary \(application\/pdf\)/);
  assert.match(md, /Response body not read: too large/);
  assert.match(md, /Transfer size: average 2\.0 KB/);
});

test('invalid JSON with a json content type is kept as text, long text samples are cut', () => {
  const store = createStore();
  addEntry(store, { method: 'GET', url: 'https://a.example/broken', status: 200, timeMs: 1, resText: `{"a": ${'x'.repeat(5000)}`, resMime: 'application/json' }, { keepExamples: true });
  const s = Object.values(store.endpoints)[0].samples[0];
  assert.equal(s.resText.length, 4003);
  assert.equal(s.cut, true);
});

test('parseBody recognises json without a content type, ignores empty and binary types', () => {
  assert.equal(parseBody('{"a":1}', undefined).kind, 'json');
  assert.equal(parseBody('hello', 'text/plain').kind, 'text');
  assert.equal(parseBody('', 'application/json'), undefined);
  assert.equal(parseBody('AAAA', 'application/pdf'), undefined);
});

test('formatBytes and normalizeMime', () => {
  assert.equal(formatBytes(830), '830 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(0), '-');
  assert.equal(normalizeMime('Application/JSON; charset=utf-8'), 'application/json');
  assert.equal(normalizeMime(undefined), '(none)');
});

test('rpcHint prefers the inner Odoo call over the generic JSON-RPC method', async () => {
  const { rpcHint } = await import('../recorder.mjs');
  assert.equal(rpcHint({ jsonrpc: '2.0', method: 'call', params: { model: 'mail.message', method: 'search_read' } }), 'mail.message.search_read');
  assert.equal(rpcHint({ method: 'getChats' }), 'getChats');
  assert.equal(rpcHint({ operationName: 'Tickets', variables: {} }), 'Tickets');
});

test('binary data read as text is recognised and not kept as a body', () => {
  const rubbish = '\u0000\u0001\u0002��\u0003abc\u0004\u0005�'.repeat(20);
  assert.equal(looksBinary(rubbish), true);
  assert.equal(parseBody(rubbish, 'text/plain'), undefined);
  assert.equal(looksBinary('{"a":1}'), false);
  assert.equal(looksBinary(''), false);
});
