import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapture } from '../capture.mjs';

function setup(getBody = async () => ({ body: '{"a":1}', base64Encoded: false })) {
  const entries = [];
  const capture = createCapture({ getBody, onEntry: (e) => entries.push(e) });
  return { entries, capture };
}

const sent = (id, type = 'XHR') => ({ requestId: id, type, timestamp: 10, request: { url: 'https://app.test/api/x', method: 'POST', postData: '{"q":1}' } });
const got = (id) => ({ requestId: id, response: { status: 200, mimeType: 'application/json' } });
const done = (id) => ({ requestId: id, timestamp: 10.25, encodedDataLength: 10 });

test('a finished XHR becomes one entry with bodies and timing', async () => {
  const { entries, capture } = setup();
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1'));
  await capture.handle(1, 'Network.responseReceived', got('r1'));
  await capture.handle(1, 'Network.loadingFinished', done('r1'));
  assert.equal(entries.length, 1);
  assert.deepEqual({ ...entries[0], timeMs: Math.round(entries[0].timeMs) },
    { method: 'POST', url: 'https://app.test/api/x', status: 200, timeMs: 250, reqText: '{"q":1}', resText: '{"a":1}', resMime: 'application/json' });
});

test('images, scripts and failed requests are ignored', async () => {
  const { entries, capture } = setup();
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1', 'Image'));
  await capture.handle(1, 'Network.loadingFinished', done('r1'));
  await capture.handle(1, 'Network.requestWillBeSent', sent('r2'));
  await capture.handle(1, 'Network.loadingFailed', { requestId: 'r2' });
  await capture.handle(1, 'Network.loadingFinished', done('r2'));
  assert.equal(entries.length, 0);
});

test('binary or unreadable body keeps the call without a body', async () => {
  const { entries, capture } = setup(async () => { throw new Error('gone'); });
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1', 'Fetch'));
  await capture.handle(1, 'Network.responseReceived', got('r1'));
  await capture.handle(1, 'Network.loadingFinished', done('r1'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resText, undefined);
});

test('same request id in two tabs does not mix, dropTab forgets a tab', async () => {
  const { entries, capture } = setup();
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1'));
  await capture.handle(2, 'Network.requestWillBeSent', sent('r1'));
  capture.dropTab(1);
  await capture.handle(1, 'Network.loadingFinished', done('r1'));
  await capture.handle(2, 'Network.loadingFinished', done('r1'));
  assert.equal(entries.length, 1);
});
