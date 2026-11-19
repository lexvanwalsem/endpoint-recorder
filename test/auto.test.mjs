import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, createStore, markStep, toMarkdown } from '../recorder.mjs';
import { addNav, describeCall, describeFlow, detectPolling, detectSteps, getSteps, nestCalls } from '../flow.mjs';

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
