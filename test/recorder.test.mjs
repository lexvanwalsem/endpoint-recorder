import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, createStore, flatten, formatBytes, normalizeMime, normalizePath, rpcHint, toMarkdown } from '../recorder.mjs';

test('normalizePath replaces ids but keeps words', () => {
  assert.equal(normalizePath('/api/tickets/12345/messages'), '/api/tickets/{id}/messages');
  assert.equal(normalizePath('/x/123e4567-e89b-12d3-a456-426614174000'), '/x/{id}');
  assert.equal(normalizePath('/web/dataset/call_kw/mail.message/search_read'), '/web/dataset/call_kw/mail.message/search_read');
});

test('rpcHint reads odoo, json-rpc and graphql bodies', () => {
  assert.equal(rpcHint({ params: { model: 'mail.message', method: 'search_read' } }), 'mail.message.search_read');
  assert.equal(rpcHint({ method: 'getChats' }), 'getChats');
  assert.equal(rpcHint({ operationName: 'Tickets' }), 'Tickets');
  assert.equal(rpcHint([1]), '');
});

function entry(url, resBody, extra = {}) {
  return { method: 'POST', url, status: 200, timeMs: 100, reqText: JSON.stringify({ params: { model: 'm', method: 'x' } }), reqMime: 'application/json', resText: JSON.stringify(resBody), resMime: 'application/json', ...extra };
}

test('same endpoint is merged, field presence and types are tracked, examples off by default', () => {
  const store = createStore();
  addEntry(store, entry('https://a.example/rpc/1?lang=nl', { items: [{ id: 1, name: 'a' }, { id: 2, name: false }] }));
  addEntry(store, entry('https://a.example/rpc/2', { items: [{ id: 3 }] }));
  const eps = Object.values(store.endpoints);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].count, 2);
  assert.deepEqual(eps[0].query, { lang: 1 });
  const rows = Object.fromEntries(flatten(eps[0].res).map((r) => [r.path, r]));
  assert.deepEqual(rows['$.items[].name'].types, ['string', 'boolean']);
  assert.equal(Math.round(rows['$.items[].name'].presence * 100), 67);
  assert.deepEqual(rows['$.items[].id'].examples, []);
});

test('examples are kept only when asked, and truncated', () => {
  const store = createStore();
  addEntry(store, entry('https://a.example/r', { secret: 'x'.repeat(100) }), { keepExamples: true });
  const row = flatten(Object.values(store.endpoints)[0].res).find((r) => r.path === '$.secret');
  assert.equal(row.examples[0].length, 40);
});

test('non-json bodies are ignored and markdown renders', () => {
  const store = createStore();
  addEntry(store, entry('https://a.example/h', null, { resText: '<html>', resMime: 'text/html' }));
  const md = toMarkdown(store);
  assert.match(md, /POST a\.example\/h/);
  assert.match(md, /Request fields/);
  assert.doesNotMatch(md, /Response fields/);
});

test('toMarkdown can be limited to chosen endpoints', () => {
  const store = createStore();
  addEntry(store, entry('https://a.example/one', { a: 1 }));
  addEntry(store, entry('https://a.example/two', { b: 1 }));
  const only = Object.values(store.endpoints).find((e) => e.path === '/two').key;
  const md = toMarkdown(store, [only]);
  assert.match(md, /a\.example\/two/);
  assert.doesNotMatch(md, /a\.example\/one/);
  assert.match(md, /Recorded endpoints \(1\)/);
});

test('sample calls are kept only with examples on, with full url, and shortened', () => {
  const big = { list: Array.from({ length: 10 }, (_, i) => ({ id: i })), text: 'x'.repeat(300) };
  const off = createStore();
  addEntry(off, entry('https://a.example/r?from=2026-11-01', big));
  assert.equal(Object.values(off.endpoints)[0].samples, undefined);

  const on = createStore();
  for (let i = 0; i < 5; i++) addEntry(on, entry(`https://a.example/r?n=${i}`, big), { keepExamples: true });
  const ep = Object.values(on.endpoints)[0];
  assert.equal(ep.samples.length, 3); // newest three
  assert.equal(ep.samples[2].url, 'https://a.example/r?n=4');
  assert.equal(ep.samples[2].res.list.length, 3);
  assert.equal(ep.samples[2].res.text.length, 203);
  assert.equal(ep.samples[2].cut, true);
});

test('markdown contains the example call with url and response', () => {
  const store = createStore();
  addEntry(store, entry('https://a.example/r?from=2026-11-01', { total: 5 }), { keepExamples: true });
  const md = toMarkdown(store);
  assert.match(md, /Example call: `POST https:\/\/a\.example\/r\?from=2026-11-01` -> 200/);
  assert.match(md, /"total": 5/);
});
