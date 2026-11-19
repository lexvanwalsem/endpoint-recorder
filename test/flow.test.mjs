import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, createStore, groupSteps, markStep, toMarkdown } from '../recorder.mjs';

const call = (method, url, res, extra = {}) => ({ method, url, status: 200, timeMs: 10, type: 'Fetch', resMime: 'application/json', resText: res === undefined ? undefined : JSON.stringify(res), ...extra });
const on = { keepExamples: true };

test('steps: calls belong to the step that was marked last', () => {
  const store = createStore();
  addEntry(store, call('GET', 'https://a.example/boot', { ok: true }), on);
  markStep(store, 'Open ticket');
  addEntry(store, call('GET', 'https://a.example/tickets/40', { id: 40 }), on);
  addEntry(store, call('GET', 'https://a.example/tickets/40/messages', []), on);
  markStep(store, '  ');
  addEntry(store, call('POST', 'https://a.example/tickets/40/close', { ok: true }), on);

  const groups = groupSteps(store);
  assert.deepEqual(groups.map((g) => [g.index, g.label, g.calls.length]), [[null, 'Before the first step', 1], [0, 'Open ticket', 2], [1, 'Step 2', 1]]);
  const md = toMarkdown(store);
  assert.match(md, /## Step 1: Open ticket/);
  assert.match(md, /- GET a\.example\/tickets\/\{id\}\n/);
  assert.match(md, /## Step 2: Step 2/);
});

test('steps: without marked steps nothing is grouped, non-API calls are left out of the report', () => {
  const store = createStore();
  addEntry(store, call('GET', 'https://a.example/x', {}), on);
  assert.deepEqual(groupSteps(store), []);
  markStep(store, 'Load page');
  addEntry(store, call('GET', 'https://a.example/app.js', undefined, { type: 'Script', resMime: 'text/javascript' }), on);
  addEntry(store, call('GET', 'https://a.example/api/me', { id: 1 }), on);
  const md = toMarkdown(store);
  assert.match(md, /GET a\.example\/api\/me/);
  const stepSection = md.split('## Step 1: Load page')[1].split('\n## GET')[0]; // up to the first endpoint section
  assert.match(stepSection, /GET a\.example\/api\/me/);
  assert.doesNotMatch(stepSection, /app\.js/);
});

test('data flow: an id returned by one call and used in a later path, query or body is linked', () => {
  const store = createStore();
  addEntry(store, call('GET', 'https://a.example/tickets', { items: [{ id: 4711, subject: 'Late parcel' }, { id: 4712, subject: 'Refund' }], total: 2 }), on);
  addEntry(store, call('POST', 'https://a.example/tickets/4711/close', { ok: true }), on);
  addEntry(store, call('GET', 'https://a.example/messages?ticket=4712', []), on);
  addEntry(store, { method: 'POST', url: 'https://a.example/rpc', status: 200, timeMs: 5, type: 'XHR', reqText: JSON.stringify({ params: { model: 'ticket', method: 'write', args: [[4711], { x: 1 }] } }), reqMime: 'application/json' }, on);

  const chains = Object.values(store.chains);
  const where = Object.fromEntries(chains.map((c) => [c.to.where, c.from.path]));
  assert.equal(where.path, '$.items[].id');
  assert.equal(where['query ticket'], '$.items[].id');
  assert.equal(where['body $.params.args[][]'], '$.items[].id');
  assert.equal(chains.find((c) => c.to.where === 'path').example, '4711');
  const md = toMarkdown(store);
  assert.match(md, /# Data flow/);
  assert.match(md, /returns `\$\.items\[\]\.id`, used in POST a\.example\/tickets\/\{id\}\/close \(path\)/);
});

test('data flow: small numbers, counts, ordinary words and self-links are not followed', () => {
  const store = createStore();
  addEntry(store, call('GET', 'https://a.example/list', { total: 25, page: 3, status: 'open', name: 'Fleur Meijer', id: 12 }), on);
  addEntry(store, call('GET', 'https://a.example/other?page=3&total=25&status=open&q=Fleur%20Meijer', {}), on);
  assert.deepEqual(Object.values(store.chains), []);

  // the same endpoint producing and consuming a value is not a chain
  addEntry(store, call('GET', 'https://a.example/next?cursor=abcdef123456', { cursor: 'abcdef123456' }), on);
  addEntry(store, call('GET', 'https://a.example/next?cursor=abcdef123456', { cursor: 'abcdef123456' }), on);
  assert.deepEqual(Object.values(store.chains), []);
});

test('data flow: a long token returned by login is linked to the calls that carry it', () => {
  const store = createStore();
  addEntry(store, call('POST', 'https://a.example/login', { session: 'a1b2c3d4e5f6a7b8c9' }), on);
  addEntry(store, call('GET', 'https://a.example/me?sid=a1b2c3d4e5f6a7b8c9', {}), on);
  const [chain] = Object.values(store.chains);
  assert.equal(chain.from.path, '$.session');
  assert.equal(chain.to.where, 'query sid');
});

test('values and chains are only kept when example data is on', () => {
  const store = createStore();
  addEntry(store, call('GET', 'https://a.example/tickets', { items: [{ id: 4711 }] }));
  addEntry(store, call('GET', 'https://a.example/tickets/4711', {}));
  assert.deepEqual(store.valueIndex, {});
  assert.deepEqual(store.chains, {});
  assert.equal(Object.values(store.endpoints)[0].found, undefined);
  assert.equal(store.calls.length, 2); // the call log holds no values, so it is always kept
});

test('found: values of responses, requests and query strings can be looked up with their field path', () => {
  const store = createStore();
  addEntry(store, call('GET', 'https://a.example/orders?customer=Mila', { items: Array.from({ length: 8 }, (_, i) => ({ name: `Customer ${i}`, total: i * 10 })) }), on);
  const ep = Object.values(store.endpoints)[0];
  const hit = ep.found.find((f) => f[2] === 'Customer 7'); // item 8: beyond the 3 shortened items of the example
  assert.deepEqual(hit, ['res', '$.items[].name', 'Customer 7']);
  assert.deepEqual(ep.found.find((f) => f[0] === 'url'), ['url', '?customer', 'Mila']);
});

test('the call log and the value index stay within their limits', () => {
  const store = createStore();
  for (let i = 0; i < 5100; i++) addEntry(store, call('GET', 'https://a.example/ping', undefined));
  assert.equal(store.calls.length, 5000);
  assert.equal(store.calls.at(-1).n, 5100);
  for (let i = 0; i < 3100; i++) addEntry(store, call('GET', `https://a.example/t${i % 3}`, { token: `tok-${i}-abcdefgh` }), on);
  assert.ok(Object.keys(store.valueIndex).length <= 3000);
});
