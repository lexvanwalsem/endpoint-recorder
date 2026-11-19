import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, createStore, markStep, subOperations, toMarkdown } from '../recorder.mjs';
import { addNav, buildGraph, buildRouteTree, describeCall, describeFlow, detectPolling, detectSteps, getSteps, lineage, nestCalls, routeTreeLines } from '../flow.mjs';
import { graphqlFields } from '../recorder.mjs';

const BASE = 1_000_000;

/** Runs fn with a controllable clock: tick(ms) sets the time to BASE + ms. */
function withClock(fn) {
  const real = Date.now;
  let t = BASE;
  Date.now = () => t;
  try {
    return fn((ms) => { t = BASE + ms; });
  } finally {
    Date.now = real;
  }
}

const call = (store, method, url, res, extra = {}) => addEntry(store, {
  method, url, status: 200, timeMs: 50, type: 'Fetch', resMime: 'application/json', resText: res === undefined ? undefined : JSON.stringify(res), ...extra,
}, { keepExamples: true });

test('a pause in the traffic starts a new step, calls close together stay in one step', () => {
  withClock((tick) => {
    const store = createStore();
    for (const [ms, url] of [[0, '/a'], [200, '/b'], [400, '/c'], [5000, '/d'], [5300, '/e'], [12000, '/f']]) {
      tick(ms);
      call(store, 'GET', `https://x.example/api${url}`, {});
    }
    const steps = detectSteps(store);
    assert.deepEqual(steps.map((s) => s.calls.length), [3, 2, 1]);
    assert.equal(steps.every((s) => s.auto), true);
  });
});

test('a navigation starts a new step even without a pause and names the step after the page', () => {
  withClock((tick) => {
    const store = createStore();
    tick(0); call(store, 'GET', 'https://x.example/api/tickets', {});
    tick(1000); addNav(store, { url: 'https://x.example/tickets/4717', at: BASE + 1000 });
    tick(1100); call(store, 'GET', 'https://x.example/api/tickets/4717', {});
    const steps = detectSteps(store);
    assert.equal(steps.length, 2);
    assert.equal(steps[1].label, 'Open /tickets/4717');
  });
});

test('single page route changes with a hash are named with the hash', () => {
  withClock((tick) => {
    const store = createStore();
    addNav(store, { url: 'https://x.example/app#/orders/12', at: BASE - 100 }); // before the call started
    tick(0); call(store, 'GET', 'https://x.example/api/orders/12', {});
    assert.equal(detectSteps(store)[0].label, 'Open /app#/orders/12');
  });
});

test('steps are named after what their main call does, a changing call wins over a reading one', () => {
  withClock((tick) => {
    const store = createStore();
    tick(0); call(store, 'GET', 'https://x.example/api/tickets/4717', {});
    tick(100); call(store, 'GET', 'https://x.example/api/tickets/4717/messages', []);
    tick(200); call(store, 'POST', 'https://x.example/api/tickets/4717/close', {});
    tick(6000); call(store, 'GET', 'https://x.example/api/tickets', {});
    const [first, second] = detectSteps(store);
    assert.equal(first.label, 'Close ticket (+2 more)');
    assert.equal(second.label, 'List tickets');
  });
});

test('describeCall gives plain names for common call shapes', () => {
  const ep = (method, path, rpc = '') => ({ method, path, rpc });
  assert.equal(describeCall(ep('GET', '/api/tickets')), 'List tickets');
  assert.equal(describeCall(ep('POST', '/api/tickets')), 'Create ticket');
  assert.equal(describeCall(ep('GET', '/api/tickets/{id}')), 'Open ticket');
  assert.equal(describeCall(ep('PUT', '/api/tickets/{id}')), 'Update ticket');
  assert.equal(describeCall(ep('DELETE', '/api/tickets/{id}')), 'Delete ticket');
  assert.equal(describeCall(ep('POST', '/api/tickets/{id}/close')), 'Close ticket');
  assert.equal(describeCall(ep('GET', '/api/tickets/{id}/messages')), 'Load messages of ticket');
  assert.equal(describeCall(ep('POST', '/api/tickets/{id}/messages')), 'Add message to ticket');
  assert.equal(describeCall(ep('POST', '/api/login')), 'Login');
  assert.equal(describeCall(ep('POST', '/NewDashboard/Statistics/GetSummary')), 'Get summary (statistics)');
  assert.equal(describeCall(ep('POST', '/web/dataset/call_kw/mail.message/search_read', 'mail.message.search_read')), 'mail.message.search_read');
});

test('regular background calls are recognised as polling and left out of the steps', () => {
  withClock((tick) => {
    const store = createStore();
    for (let i = 0; i < 5; i++) { tick(i * 10_000); call(store, 'GET', 'https://x.example/api/notifications', {}); }
    tick(20_000); call(store, 'POST', 'https://x.example/api/tickets/4717/close', {});
    const polling = detectPolling(store);
    assert.equal(polling.size, 1);
    const [{ intervalMs, count }] = polling.values();
    assert.equal(count, 5);
    assert.ok(Math.abs(intervalMs - 10_000) < 100);
    const steps = detectSteps(store);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].label, 'Close ticket');
    const md = toMarkdown(store);
    assert.match(md, /## Background calls/);
    assert.match(md, /GET x\.example\/api\/notifications about every 10 s \(5 calls\)/);
  });
});

test('irregular repeated calls are not polling', () => {
  withClock((tick) => {
    const store = createStore();
    for (const ms of [0, 1000, 9000, 9500, 30_000]) { tick(ms); call(store, 'GET', 'https://x.example/api/search', {}); }
    assert.equal(detectPolling(store).size, 0);
  });
});

test('marked steps win over detected ones, and the other kind can still be asked for', () => {
  withClock((tick) => {
    const store = createStore();
    tick(0); call(store, 'GET', 'https://x.example/api/a', {});
    markStep(store, 'My step');
    tick(100); call(store, 'GET', 'https://x.example/api/b', {});
    assert.equal(getSteps(store)[1].label, 'My step');
    assert.equal(getSteps(store, 'auto')[0].auto, true);
    assert.equal(getSteps(store, 'manual')[1].label, 'My step');
    assert.equal(getSteps(createStore()).length, 0);
  });
});

/** Login, list, open, close: the typical chain of values travelling from step to step. */
function scenario() {
  const store = createStore();
  withClock((tick) => {
    tick(0); call(store, 'POST', 'https://x.example/api/login', { session: 'a1b2c3d4e5f6a7b8c9d0' });
    tick(5000); call(store, 'GET', 'https://x.example/api/tickets?sid=a1b2c3d4e5f6a7b8c9d0', { items: [{ id: 4711 }, { id: 4717 }] });
    tick(10_000); call(store, 'GET', 'https://x.example/api/tickets/4717', { id: 4717, subject: 'Late parcel' });
    tick(10_200); call(store, 'GET', 'https://x.example/api/tickets/4717/messages', []);
    tick(15_000); call(store, 'POST', 'https://x.example/api/tickets/4717/close', { ok: true });
  });
  return store;
}

test('flow: what a step needs, what happens inside it and what it passes on', () => {
  const store = scenario();
  const groups = getSteps(store);
  assert.deepEqual(groups.map((g) => g.label), ['Login', 'List tickets', 'Open ticket (+1 more)', 'Close ticket']);
  const flow = describeFlow(store, groups);

  assert.equal(flow[0].needs.length, 0);
  assert.deepEqual(flow[0].gives.map((e) => [e.from.path, e.toStep]), [['$.session', 1]]);
  assert.deepEqual(flow[1].needs.map((e) => [e.to.where, e.fromStep]), [['query sid', 0]]);
  assert.deepEqual(flow[2].needs.map((e) => [e.to.where, e.from.path, e.fromStep]), [['path', '$.items[].id', 1]]);
  assert.equal(flow[2].inner.length, 1); // the ticket id returned by the first call is used in the messages call
  assert.equal(flow[2].inner[0].from.path, '$.id');
  assert.deepEqual(flow[3].needs.map((e) => [e.from.path, e.fromStep]), [['$.id', 2]]); // newest producer wins
});

test('flow: the report explains in sentences where values come from and where they go', () => {
  const md = toMarkdown(scenario());
  assert.match(md, /Steps detected automatically/);
  assert.match(md, /## Step 3: Open ticket \(\+1 more\)/);
  assert.match(md, /Needs:\n- `path` of GET \/api\/tickets\/\{id\} comes from step 2: GET \/api\/tickets returns `\$\.items\[\]\.id`/);
  assert.match(md, /Passes on:\n- `\$\.session` of POST \/api\/login is used in step 2: GET \/api\/tickets \(query sid\)/);
  assert.match(md, /Within this step:/);
});

test('stores recorded before the flow existed give no links and no errors', () => {
  const store = scenario();
  for (const chain of Object.values(store.chains)) delete chain.pairs;
  const flow = describeFlow(store, getSteps(store));
  assert.equal(flow.every((f) => f.needs.length === 0 && f.gives.length === 0 && f.inner.length === 0), true);
  assert.doesNotThrow(() => toMarkdown(store));
});

test('the start time of a call is stored, so pauses can be found', () => {
  withClock((tick) => {
    const store = createStore();
    tick(1000); call(store, 'GET', 'https://x.example/api/a', {});
    assert.equal(store.calls[0].at - store.calls[0].s, 50);
  });
});

test('a step that changes several things names the first two, a reading step names one call', () => {
  withClock((tick) => {
    const store = createStore();
    tick(0); call(store, 'POST', 'https://x.example/api/tickets/4717/messages', {});
    tick(100); call(store, 'POST', 'https://x.example/api/tickets/4717/close', {});
    tick(200); call(store, 'GET', 'https://x.example/api/tickets', {});
    tick(6000); call(store, 'GET', 'https://x.example/api/tickets/4717', {});
    tick(6100); call(store, 'GET', 'https://x.example/api/customers', {});
    assert.deepEqual(detectSteps(store).map((s) => s.label), ['Add message to ticket + Close ticket (+1 more)', 'Open ticket (+1 more)']);
  });
});

test('nested calls: a call that used a value from an earlier call in the same step is shown under it', () => {
  const store = scenario();
  const openTicket = getSteps(store)[2]; // GET /tickets/{id}, then GET /tickets/{id}/messages that uses the id it returned
  const tree = nestCalls(store, openTicket.calls);
  assert.deepEqual(tree.map((t) => [store.endpoints[t.call.key].path, t.depth]), [['/api/tickets/{id}', 0], ['/api/tickets/{id}/messages', 1]]);
  // a step without links inside has a flat list
  const login = nestCalls(store, getSteps(store)[0].calls);
  assert.deepEqual(login.map((t) => t.depth), [0]);
  // values from an earlier step do not nest: the close call is a root of its own step
  assert.deepEqual(nestCalls(store, getSteps(store)[3].calls).map((t) => t.depth), [0]);
});

test('graph: calls become nodes, values travelling between them become edges, laid out from the start of the data to its end', () => {
  const store = scenario();
  const graph = buildGraph(store, { groups: getSteps(store) });
  const byPath = Object.fromEntries(graph.nodes.map((n) => [`${n.method} ${n.path}`, n]));

  assert.deepEqual(Object.keys(byPath).sort(), ['GET /api/tickets', 'GET /api/tickets/{id}', 'GET /api/tickets/{id}/messages', 'POST /api/login', 'POST /api/tickets/{id}/close']);
  assert.equal(byPath['POST /api/login'].layer, 0);
  assert.equal(byPath['GET /api/tickets'].layer, 1);
  assert.equal(byPath['GET /api/tickets/{id}'].layer, 2);
  assert.equal(byPath['GET /api/tickets/{id}/messages'].layer, 3);
  assert.equal(byPath['POST /api/tickets/{id}/close'].layer, 3);
  assert.ok(byPath['GET /api/tickets'].x > byPath['POST /api/login'].x);
  assert.deepEqual(byPath['POST /api/login'].steps, [1]); // the step numbers that used the endpoint

  const edge = graph.edges.find((e) => store.endpoints[e.from].path === '/api/tickets' && store.endpoints[e.to].path === '/api/tickets/{id}');
  assert.deepEqual(edge.labels, ['$.items[].id -> path']);
  assert.equal(graph.edges.every((e) => !e.back), true);
  assert.deepEqual(graph.unlinked, []);
});

test('graph: the lineage of a node is the path from the login to it, with the side branches that belong to it', () => {
  const store = scenario();
  const graph = buildGraph(store);
  const keyOf = (p, m = 'GET') => Object.values(store.endpoints).find((e) => e.path === p && e.method === m).key;
  const close = lineage(graph, keyOf('/api/tickets/{id}/close', 'POST'));
  assert.deepEqual(close.path.map((k) => store.endpoints[k].path), ['/api/login', '/api/tickets', '/api/tickets/{id}', '/api/tickets/{id}/close']);
  assert.equal(close.keys.has(keyOf('/api/tickets/{id}/messages')), false); // a sibling is not part of its lineage

  const ticket = lineage(graph, keyOf('/api/tickets/{id}'));
  assert.equal(ticket.keys.has(keyOf('/api/tickets/{id}/messages')), true); // what it leads to
  assert.equal(ticket.keys.has(keyOf('/api/login', 'POST')), true); // what leads to it
});

test('graph: endpoints without links are listed apart, a loop between endpoints does not break the layout', () => {
  withClock((tick) => {
    const store = createStore();
    tick(0); call(store, 'GET', 'https://x.example/api/a', { aid: 'tok-aaaaaaaaaaaa' });
    tick(100); call(store, 'GET', 'https://x.example/api/b?t=tok-aaaaaaaaaaaa', { bid: 'tok-bbbbbbbbbbbb' });
    tick(200); call(store, 'GET', 'https://x.example/api/a?t=tok-bbbbbbbbbbbb', { aid: 'tok-cccccccccccc' }); // links back to a
    tick(300); call(store, 'GET', 'https://x.example/api/lonely', {});
    const graph = buildGraph(store);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 2);
    assert.equal(graph.edges.filter((e) => e.back).length, 1);
    assert.deepEqual(graph.unlinked.map((k) => store.endpoints[k].path), ['/api/lonely']);
    assert.ok(graph.width > 0 && graph.height > 0);
  });
});

test('route tree: the paths of the API as a tree with methods, counts and steps', () => {
  const store = scenario();
  call(store, 'GET', 'https://x.example/api/customers/search?q=a', {});
  const trees = buildRouteTree(store, { groups: getSteps(store) });
  assert.deepEqual(routeTreeLines(trees), [
    '- x.example',
    '  - /api',
    '    - /customers/search  GET x1 (step 5)',
    '    - /login  POST x1 (step 1)',
    '    - /tickets  GET x1 (step 2)',
    '      - /{id}  GET x1 (step 3)',
    '        - /close  POST x1 (step 4)',
    '        - /messages  GET x1 (step 3)',
  ]);
});

test('sub-operations: a JSON batch and a GraphQL query with several fields are split into their parts', () => {
  assert.deepEqual(subOperations([{ method: 'getUser' }, { method: 'getOrders' }]), ['getUser', 'getOrders']);
  assert.deepEqual(subOperations([{ operationName: 'A' }, {}]), ['A', '#2']);
  assert.deepEqual(subOperations([{ method: 'only' }]), []);
  assert.deepEqual(graphqlFields('{ me { id } orders(first: 5) { id name } ping }'), ['me', 'orders', 'ping']);
  assert.deepEqual(graphqlFields('query Dash { a: user(id: 1) { id } b: orders { id } }'), ['user', 'orders']);
  assert.deepEqual(graphqlFields('query { me { ...Frag friends { id } } }'), ['me']);
  assert.deepEqual(subOperations({ query: '{ me { id } orders { id } }' }), ['me', 'orders']);
  assert.deepEqual(subOperations({ query: '{ me { id } }' }), []); // one field: nothing to split
  assert.deepEqual(subOperations({ some: 'thing' }), []);
});

test('sub-operations are stored on the endpoint and the call, and named in the report', () => {
  withClock((tick) => {
    const store = createStore();
    tick(0);
    addEntry(store, { method: 'POST', url: 'https://x.example/graphql', status: 200, timeMs: 5, type: 'Fetch', reqText: JSON.stringify({ query: '{ me { id } orders { id } }' }), reqMime: 'application/json', resText: '{}', resMime: 'application/json' }, { keepExamples: true });
    const ep = Object.values(store.endpoints)[0];
    assert.deepEqual(ep.subs, { me: 1, orders: 1 });
    assert.deepEqual(store.calls[0].subs, ['me', 'orders']);
    assert.match(toMarkdown(store), /- Contains sub-calls: me x1, orders x1/);
  });
});
