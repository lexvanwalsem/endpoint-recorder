import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, paginationHints, parseCookieHeader, parseSetCookie, rateLimitHints, summarizeHeaders } from '../headers.mjs';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLWJ5dGVz';
const SECRETS = [JWT, 'sess-4f9a8c2e1b7d', 'csrf-secret-value-1', 'apikey-9988776655', 'ref-token-abcdef'];

test('request headers: names, harmless values and the kind of authentication, never the values of secrets', async () => {
  const out = await summarizeHeaders({
    req: {
      Authorization: `Bearer ${JWT}`, Cookie: 'sid=sess-4f9a8c2e1b7d; theme=dark', 'X-CSRF-Token': 'csrf-secret-value-1', 'X-Api-Key': 'apikey-9988776655',
      Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0', Host: 'x', 'Sec-Fetch-Mode': 'cors', 'Accept-Language': 'nl',
    },
  });
  assert.equal(out.req.auth, 'Bearer (JWT)');
  assert.deepEqual(out.req.cookies, ['sid', 'theme']);
  assert.deepEqual(out.req.safe, { accept: 'application/json', 'content-type': 'application/json; charset=utf-8', 'x-requested-with': 'XMLHttpRequest' });
  assert.deepEqual(out.req.names.sort(), ['accept', 'authorization', 'content-type', 'x-api-key', 'x-csrf-token', 'x-requested-with']);
  // 'theme=dark' is too short to be a token, so it is not fingerprinted; the cookie name is still listed above
  assert.deepEqual(out.tokensIn.map((x) => x.where).sort(), ['header authorization', 'header cookie sid', 'header x-api-key', 'header x-csrf-token']);
  const text = JSON.stringify(out);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${secret} must not be in the summary`);
  assert.match(out.tokensIn[0].hash, /^[0-9a-f]{12}$/);
});

test('other schemes: Basic and a custom one are named by their scheme only', async () => {
  assert.equal((await summarizeHeaders({ req: { authorization: 'Basic dXNlcjpwYXNz' } })).req.auth, 'Basic');
  assert.equal((await summarizeHeaders({ req: { authorization: 'Bearer not-a-jwt-token-value' } })).req.auth, 'Bearer');
  assert.equal((await summarizeHeaders({ req: { authorization: 'Token abcdef123456' } })).req.auth, 'Token');
});

test('response headers: paging, rate limits, cookie names and the challenge, never cookie values', async () => {
  const out = await summarizeHeaders({
    res: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', Link: '<https://x/api?page=2>; rel="next", <https://x/api?page=9>; rel="last"',
      'X-Total-Count': '345', 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '59', 'WWW-Authenticate': 'Bearer realm="api"',
      'Set-Cookie': 'sid=sess-4f9a8c2e1b7d; Path=/; HttpOnly', Location: '/api/tickets/4717?x=1', Date: 'now', Server: 'nginx', 'X-Auth-Token': 'ref-token-abcdef',
    },
  });
  assert.deepEqual(out.res.rels, ['next', 'last']);
  assert.equal(out.res.safe['x-total-count'], '345');
  assert.equal(out.res.www, 'Bearer');
  assert.deepEqual(out.res.setCookies, ['sid']);
  assert.equal(out.res.location, '/api/tickets/4717');
  assert.equal(out.res.names.includes('date'), false);
  assert.deepEqual(out.tokensOut.map((t) => t.where).sort(), ['header x-auth-token', 'set-cookie sid']);
  const text = JSON.stringify(out);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${secret} must not be in the summary`);
});

test('a separate Set-Cookie event is used when the header is not in the normal response headers', async () => {
  const out = await summarizeHeaders({ res: {}, setCookie: 'sid=abcdef123456; Path=/\ncsrf=zzzzzz987654; Secure' });
  assert.deepEqual(out.res.setCookies, ['sid', 'csrf']);
  assert.equal(out.tokensOut.length, 2);
});

test('the fingerprint is stable, short and does not contain the value', async () => {
  const a = await fingerprint('sess-4f9a8c2e1b7d');
  assert.equal(a, await fingerprint('sess-4f9a8c2e1b7d'));
  assert.notEqual(a, await fingerprint('sess-4f9a8c2e1b7e'));
  assert.equal(a.length, 12);
});

test('cookie header parsing and paging and rate limit hints', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=2;c'), [['a', '1'], ['b', '2'], ['c', '']]);
  assert.deepEqual(parseSetCookie('a=1; Path=/\nb=2; Secure'), [['a', '1'], ['b', '2']]);
  const ep = { query: { page: 1, limit: 1, q: 1 }, rels: { next: 2, last: 2 }, safeHeaders: { 'response x-total-count': { 345: 2 }, 'response x-ratelimit-limit': { 60: 2 }, 'response retry-after': { 30: 1 } } };
  assert.deepEqual(paginationHints(ep), ['query: page, limit', 'Link header: next, last', 'x-total-count: 345']);
  assert.deepEqual(rateLimitHints(ep), ['x-ratelimit-limit: 60', 'retry-after: 30']);
  assert.deepEqual(paginationHints({}), []);
});
