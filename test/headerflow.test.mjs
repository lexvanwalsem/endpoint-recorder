import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapture } from '../capture.mjs';
import { addEntry, createStore, toMarkdown } from '../recorder.mjs';
import { buildGraph, getSteps } from '../flow.mjs';
import { devNotes, summarizeHeaders } from '../headers.mjs';

const SECRET_TOKEN = 'secret-bearer-token-123456';
const SECRET_COOKIE = 'sess-9f8e7d6c5b4a';

function setup(analyse = true) {
  const entries = [];
  const capture = createCapture({ getBody: async () => ({ body: '{"ok":true}', base64Encoded: false }), onEntry: (e) => entries.push(e), analyseHeaders: () => analyse });
  return { entries, capture };
}

async function fakeCall(capture, { extraFirst = false } = {}) {
  const requestWillBeSent = { requestId: 'r1', type: 'XHR', timestamp: 1, request: { url: 'https://x.example/api/tickets', method: 'GET', headers: { Authorization: `Bearer ${SECRET_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' } } };
  const extra = { requestId: 'r1', headers: { Cookie: `sid=${SECRET_COOKIE}` } };
  if (extraFirst) await capture.handle(1, 'Network.requestWillBeSentExtraInfo', extra);
  await capture.handle(1, 'Network.requestWillBeSent', requestWillBeSent);
  if (!extraFirst) await capture.handle(1, 'Network.requestWillBeSentExtraInfo', extra);
  await capture.handle(1, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'application/json', headers: { 'Cache-Control': 'no-store', 'X-Total-Count': '345', Link: '<x>; rel="next"' } } });
  await capture.handle(1, 'Network.responseReceivedExtraInfo', { requestId: 'r1', headers: { 'set-cookie': `sid=${SECRET_COOKIE}; HttpOnly` } });
  await capture.handle(1, 'Network.loadingFinished', { requestId: 'r1', timestamp: 1.1, encodedDataLength: 50 });
}

test('capture: headers of a call are summarised, the cookie and set-cookie events are merged, no secret is in the entry', async () => {
  for (const extraFirst of [false, true]) {
    const { entries, capture } = setup();
    await fakeCall(capture, { extraFirst });
    const h = entries[0].headers;
    assert.equal(h.req.auth, 'Bearer');
    assert.deepEqual(h.req.cookies, ['sid']);
    assert.deepEqual(h.res.setCookies, ['sid']);
    assert.deepEqual(h.res.rels, ['next']);
    assert.equal(h.res.safe['x-total-count'], '345');
    assert.deepEqual(h.tokensIn.map((t) => t.where).sort(), ['header authorization', 'header cookie sid']);
    const text = JSON.stringify(entries);
    assert.equal(text.includes(SECRET_TOKEN) || text.includes(SECRET_COOKIE), false, 'no secret may be in the entry');
  }
});

test('capture: with header analysis off there is no header summary at all', async () => {
  const { entries, capture } = setup(false);
  await fakeCall(capture);
  assert.equal(entries[0].headers, undefined);
  assert.equal(JSON.stringify(entries).includes(SECRET_COOKIE), false);
});

async function login(store) {
  const headers = await summarizeHeaders({ req: { Accept: 'application/json' }, res: { 'Set-Cookie': `sid=${SECRET_COOKIE}; Path=/`, 'X-Auth-Token': 'refresh-token-abcdef12' } });
  addEntry(store, { method: 'POST', url: 'https://x.example/api/login', status: 200, timeMs: 5, type: 'Fetch', resText: '{"ok":true}', resMime: 'application/json', headers }, { keepExamples: true });
}

async function listTickets(store) {
  const headers = await summarizeHeaders({
    req: { Cookie: `sid=${SECRET_COOKIE}`, Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', 'X-Auth-Token': 'refresh-token-abcdef12', Accept: 'application/json' },
    res: { 'Cache-Control': 'no-store', ETag: 'W/"abc"', 'X-Total-Count': '345', Link: '<a>; rel="next", <b>; rel="last"', 'X-RateLimit-Limit': '60', 'Access-Control-Allow-Origin': '*', Server: 'nginx', 'X-Request-Id': 'abc-123-def-456' },
  });
  addEntry(store, { method: 'GET', url: 'https://x.example/api/tickets?page=1&limit=20', status: 200, timeMs: 5, type: 'Fetch', resText: '{"items":[]}', resMime: 'application/json', headers }, { keepExamples: true });
}

test('a cookie or token returned by one call and sent in the next is linked, by fingerprint', async () => {
  const store = createStore();
  await login(store);
  await listTickets(store);
  const chains = Object.values(store.chains);
  const links = Object.fromEntries(chains.map((c) => [c.to.where, c.from.path]));
  assert.equal(links['header cookie sid'], 'set-cookie sid');
  assert.equal(links['header x-auth-token'], 'header x-auth-token');
  const graph = buildGraph(store);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0].labels.sort(), ['header x-auth-token -> header x-auth-token', 'set-cookie sid -> header cookie sid']);
  // the recording itself holds no secret
  const text = JSON.stringify(store);
  assert.equal(text.includes(SECRET_COOKIE) || text.includes('refresh-token-abcdef12') || text.includes('eyJhbGciOiJIUzI1NiJ9'), false);
});

test('developer notes: authentication, paging, rate limit, caching, CORS, tracing and the stack', async () => {
  const store = createStore();
  await listTickets(store);
  const ep = Object.values(store.endpoints)[0];
  const notes = Object.fromEntries(devNotes(ep));
  assert.match(notes.Authentication, /Bearer \(JWT\)/);
  assert.match(notes.Authentication, /cookies: sid/);
  assert.match(notes.Authentication, /headers: x-auth-token/);
  assert.match(notes.Pagination, /query: page, limit/);
  assert.match(notes.Pagination, /Link header: next, last/);
  assert.match(notes.Pagination, /x-total-count: 345/);
  assert.match(notes['Rate limit'], /x-ratelimit-limit: 60/);
  assert.match(notes.Caching, /cache-control: no-store/);
  assert.match(notes.Caching, /ETag \(weak\)/);
  assert.match(notes.CORS, /allow-origin: \*/);
  assert.match(notes['Tracing ids'], /x-request-id/);
  assert.equal(notes.Stack, 'nginx');
});

test('the report has an authentication overview and the notes per endpoint, without values', async () => {
  const store = createStore();
  await login(store);
  await listTickets(store);
  const md = toMarkdown(store);
  assert.match(md, /# Authentication/);
  assert.match(md, /- x\.example: .*Bearer \(JWT\) \(1 calls\).*cookies sent: sid.*cookies set: sid.*headers: x-auth-token/);
  assert.match(md, /- Pagination: query: page, limit; Link header: next, last/);
  assert.match(md, /- Caching: cache-control: no-store; ETag \(weak\)/);
  assert.equal(md.includes(SECRET_COOKIE), false);
  assert.ok(getSteps(store).length >= 1);
});

test('calls without a header summary still work and add no header fields', () => {
  const store = createStore();
  addEntry(store, { method: 'GET', url: 'https://x.example/api/a', status: 200, timeMs: 1, type: 'Fetch', resText: '{}', resMime: 'application/json' }, { keepExamples: true });
  const ep = Object.values(store.endpoints)[0];
  assert.equal(ep.auth, undefined);
  assert.deepEqual(devNotes(ep), []);
  assert.doesNotMatch(toMarkdown(store), /# Authentication/);
});
