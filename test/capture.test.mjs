import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapture, MAX_BODY } from '../capture.mjs';

function setup(getBody = async () => ({ body: '{"a":1}', base64Encoded: false }), wantAll = () => false) {
  const entries = [];
  const capture = createCapture({ getBody, onEntry: (e) => entries.push(e), wantAll });
  return { entries, capture };
}

const sent = (id, type = 'XHR', headers = { 'Content-Type': 'application/json', Cookie: 'secret=1', Authorization: 'Bearer x' }) =>
  ({ requestId: id, type, timestamp: 10, request: { url: 'https://app.test/api/x', method: 'POST', postData: '{"q":1}', headers } });
const got = (id, mimeType = 'application/json') => ({ requestId: id, response: { status: 200, mimeType } });
const done = (id, size = 10) => ({ requestId: id, timestamp: 10.25, encodedDataLength: size });

test('a finished XHR becomes one entry with bodies, sizes and timing', async () => {
  const { entries, capture } = setup();
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1'));
  await capture.handle(1, 'Network.responseReceived', got('r1'));
  await capture.handle(1, 'Network.loadingFinished', done('r1', 1234));
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.method, 'POST');
  assert.equal(e.url, 'https://app.test/api/x');
  assert.equal(e.status, 200);
  assert.equal(Math.round(e.timeMs), 250);
  assert.equal(e.size, 1234);
  assert.equal(e.type, 'XHR');
  assert.equal(e.reqText, '{"q":1}');
  assert.equal(e.reqMime, 'application/json');
  assert.equal(e.resText, '{"a":1}');
});

test('only the content type of the request headers is read, never cookies or tokens', async () => {
  const { entries, capture } = setup();
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1'));
  await capture.handle(1, 'Network.responseReceived', got('r1'));
  await capture.handle(1, 'Network.loadingFinished', done('r1'));
  assert.doesNotMatch(JSON.stringify(entries), /secret|Bearer/);
});

test('images and scripts are ignored by default, failed requests never produce an entry', async () => {
  const { entries, capture } = setup();
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1', 'Image'));
  await capture.handle(1, 'Network.loadingFinished', done('r1'));
  await capture.handle(1, 'Network.requestWillBeSent', sent('r2'));
  await capture.handle(1, 'Network.loadingFailed', { requestId: 'r2' });
  await capture.handle(1, 'Network.loadingFinished', done('r2'));
  assert.equal(entries.length, 0);
});

test('with wantAll every type is recorded: images keep type and size but no body', async () => {
  let bodyRequests = 0;
  const { entries, capture } = setup(async () => { bodyRequests++; return { body: 'x', base64Encoded: false }; }, () => true);
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1', 'Image', {}));
  await capture.handle(1, 'Network.responseReceived', got('r1', 'image/png'));
  await capture.handle(1, 'Network.loadingFinished', done('r1', 5000));
  assert.equal(bodyRequests, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'Image');
  assert.equal(entries[0].size, 5000);
  assert.equal(entries[0].resText, undefined);
});

test('html responses are read as text, binary ones are flagged', async () => {
  const { entries, capture } = setup(async () => ({ body: '<p>hi</p>', base64Encoded: false }));
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1'));
  await capture.handle(1, 'Network.responseReceived', got('r1', 'text/html'));
  await capture.handle(1, 'Network.loadingFinished', done('r1'));
  assert.equal(entries[0].resText, '<p>hi</p>');

  const bin = setup(async () => ({ body: 'AAAA', base64Encoded: true }));
  await bin.capture.handle(1, 'Network.requestWillBeSent', sent('r2'));
  await bin.capture.handle(1, 'Network.responseReceived', got('r2', 'application/pdf'));
  await bin.capture.handle(1, 'Network.loadingFinished', done('r2'));
  assert.equal(bin.entries[0].binary, true);
  assert.equal(bin.entries[0].resText, undefined);
});

test('large bodies are read up to the cap, beyond it the call is kept without body', async () => {
  const { entries, capture } = setup();
  await capture.handle(1, 'Network.requestWillBeSent', sent('big1'));
  await capture.handle(1, 'Network.responseReceived', got('big1'));
  await capture.handle(1, 'Network.loadingFinished', done('big1', 20_000_000)); // 20 MB: still read
  await capture.handle(1, 'Network.requestWillBeSent', sent('big2'));
  await capture.handle(1, 'Network.responseReceived', got('big2'));
  await capture.handle(1, 'Network.loadingFinished', done('big2', MAX_BODY + 1));
  assert.equal(entries[0].resText, '{"a":1}');
  assert.equal(entries[1].resText, undefined);
  assert.equal(entries[1].skipped, 'too large');
});

test('unreadable body keeps the call and says why', async () => {
  const { entries, capture } = setup(async () => { throw new Error('gone'); });
  await capture.handle(1, 'Network.requestWillBeSent', sent('r1', 'Fetch'));
  await capture.handle(1, 'Network.responseReceived', got('r1'));
  await capture.handle(1, 'Network.loadingFinished', done('r1'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resText, undefined);
  assert.equal(entries[0].skipped, 'not available');
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
