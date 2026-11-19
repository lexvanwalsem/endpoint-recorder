import { test } from 'node:test';
import assert from 'node:assert/strict';

// A fake chrome API, enough to load background.js and talk to it like the popup does.
const writes = [];
const local = new Map();
const session = new Map();
const listeners = { message: null, debugger: null };
const noop = () => {};
const keyed = (map) => async (keys) => {
  const list = [].concat(keys);
  return Object.fromEntries(list.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
};

globalThis.chrome = {
  storage: {
    local: { get: keyed(local), set: async (obj) => { writes.push(Object.keys(obj)); for (const [k, v] of Object.entries(obj)) local.set(k, structuredClone(v)); } },
    session: { get: keyed(session), set: async (obj) => { for (const [k, v] of Object.entries(obj)) session.set(k, structuredClone(v)); } },
    onChanged: { addListener: noop },
  },
  runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } }, onSuspend: { addListener: noop } },
  debugger: {
    onEvent: { addListener: (fn) => { listeners.debugger = fn; } },
    onDetach: { addListener: noop },
    attach: async () => {}, detach: async () => {},
    sendCommand: async (_target, method) => (method === 'Network.getResponseBody' ? { body: '{"ok":true,"id":12345}', base64Encoded: false } : {}),
  },
  tabs: { onUpdated: { addListener: noop } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

await import('../background.js');

const ask = (msg) => new Promise((resolve) => listeners.message(msg, {}, resolve));
const event = (method, params) => listeners.debugger({ tabId: 7 }, method, params);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeCall(i) {
  const requestId = `r${i}`;
  await event('Network.requestWillBeSent', { requestId, type: 'XHR', timestamp: i, request: { url: `https://app.example/api/items/${i}`, method: 'GET', headers: {} } });
  await event('Network.responseReceived', { requestId, response: { status: 200, mimeType: 'application/json' } });
  await event('Network.loadingFinished', { requestId, timestamp: i + 0.05, encodedDataLength: 100 });
}

test('a busy page does not block the popup, stop is immediate and the recording is saved in batches', async () => {
  assert.equal((await ask({ type: 'start', tabId: 7 })).ok, true);
  assert.equal((await ask({ type: 'status', tabId: 7 })).recording, true);

  // 400 calls in a burst, like a busy dashboard
  await Promise.all(Array.from({ length: 400 }, (_, i) => fakeCall(i)));

  // the popup gets its answer straight away and sees the calls that are in
  const t0 = performance.now();
  const status = await ask({ type: 'status', tabId: 7 });
  assert.ok(performance.now() - t0 < 500, 'status answers quickly');
  assert.equal(status.recording, true);
  assert.equal(status.calls, 400);
  assert.equal(status.endpoints, 1); // /api/items/{id}

  // far fewer writes than calls: at most one per second, not one per call
  await sleep(1200);
  const storeWrites = writes.filter((keys) => keys.includes('store')).length;
  assert.ok(storeWrites >= 1 && storeWrites <= 3, `store written ${storeWrites} times`);
  assert.equal(local.get('store').calls.length, 400);

  // stopping answers at once and keeps what was recorded
  const t1 = performance.now();
  assert.equal((await ask({ type: 'stop', tabId: 7 })).ok, true);
  assert.ok(performance.now() - t1 < 500, 'stop answers quickly');
  assert.equal((await ask({ type: 'status', tabId: 7 })).recording, false);
  assert.equal(local.get('store').calls.length, 400);
});

test('marking a step and clearing work through the background worker', async () => {
  const marked = await ask({ type: 'mark', label: 'Open ticket' });
  assert.equal(marked.label, 'Open ticket');
  assert.equal((await ask({ type: 'status', tabId: 7 })).lastStep, 'Open ticket');
  await ask({ type: 'clear' });
  const status = await ask({ type: 'status', tabId: 7 });
  assert.equal(status.endpoints, 0);
  assert.equal(status.stepCount, 0);
  assert.equal(local.get('store').calls.length, 0);
});
