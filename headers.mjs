// Header analysis: which headers an endpoint uses and a few harmless values. Cookie and token values are NEVER kept:
// of a token only a short fingerprint (hash) is kept, so a token returned by one call can be recognised in a later call.
// Pure logic (the hash needs crypto.subtle, which exists in browsers, service workers and Node).

/** Headers whose values say something about the API and are harmless to keep. */
const SAFE_REQUEST = new Set(['accept', 'content-type', 'x-requested-with', 'x-api-version', 'api-version', 'accept-version', 'origin', 'range']);
const SAFE_RESPONSE = new Set([
  // content, caching and paging
  'content-type', 'content-encoding', 'content-language', 'cache-control', 'expires', 'age', 'last-modified', 'vary', 'accept-ranges', 'allow',
  'x-total-count', 'x-page', 'x-per-page', 'retry-after',
  // rate limits
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
  // versions and life cycle
  'deprecation', 'sunset', 'api-version', 'x-api-version',
  // the stack and timing
  'server', 'x-powered-by', 'server-timing',
  // CORS and security policy
  'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers',
  'access-control-allow-credentials', 'access-control-max-age', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy',
]);
// headers the browser adds itself or that say nothing about the API
const NOISE_REQUEST = /^(:|sec-|user-agent$|accept-encoding$|accept-language$|connection$|host$|referer$|origin$|dnt$|priority$|upgrade-insecure|pragma$|cache-control$|content-length$)/;
const NOISE_RESPONSE = /^(:|date$|content-length$|connection$|keep-alive$|transfer-encoding$|alt-svc$|nel$|report-to$)/;

/** Names of headers that carry a credential or a session. */
export const TOKENISH = /(token|key|auth|csrf|xsrf|session|secret|signature|jwt|bearer)/i;
const NOT_A_TOKEN = /^(content-|accept|cache-|access-control-|x-ratelimit|ratelimit|www-authenticate)/;

const lower = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
const cut = (text, n = 80) => String(text).slice(0, n);

/** A short fingerprint of a value: 12 hex characters of its SHA-256. */
export async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const looksLikeSecret = (s) => s.length >= 6 && s.length <= 4000 && !/\s/.test(s);

/** 'sid=abc; theme=dark' -> [['sid', 'abc'], ['theme', 'dark']] */
export function parseCookieHeader(text) {
  return String(text ?? '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    return i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)];
  });
}

/** Set-Cookie lines (one per line) -> [[name, value]] */
export function parseSetCookie(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const first = line.split(';')[0];
    const i = first.indexOf('=');
    return i < 0 ? [first, ''] : [first.slice(0, i).trim(), first.slice(i + 1).trim()];
  });
}

/**
 * Summarise the headers of one call.
 * req/res: header objects as the browser reports them. setCookie: the Set-Cookie lines (separate event, may be undefined).
 * -> { req: { names, safe, auth, cookies }, res: { names, safe, rels, www, setCookies, location },
 *      tokensIn: [{ where, hash }], tokensOut: [{ where, hash }] }   (no cookie or token value is in the result)
 */
export async function summarizeHeaders({ req, res, setCookie } = {}) {
  const rq = lower(req);
  const rs = lower(res);
  const tokensIn = [];
  const tokensOut = [];
  const add = async (list, where, value) => { if (looksLikeSecret(value)) list.push({ where, hash: await fingerprint(value) }); };

  // request
  const request = { names: Object.keys(rq).filter((n) => !NOISE_REQUEST.test(n) && n !== 'cookie'), safe: {}, auth: '', cookies: [] };
  for (const n of Object.keys(rq)) if (SAFE_REQUEST.has(n)) request.safe[n] = cut(rq[n]);
  if (rq.authorization) {
    const m = /^(\S+)\s+(.+)$/.exec(rq.authorization);
    const scheme = m ? m[1] : 'custom';
    request.auth = /^bearer$/i.test(scheme) && /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(m[2]) ? 'Bearer (JWT)' : cut(scheme, 20);
    await add(tokensIn, 'header authorization', m ? m[2] : rq.authorization);
  }
  for (const [name, value] of parseCookieHeader(rq.cookie)) {
    request.cookies.push(name);
    await add(tokensIn, `header cookie ${name}`, value);
  }
  for (const n of Object.keys(rq)) {
    if (n === 'authorization' || n === 'cookie' || NOT_A_TOKEN.test(n) || !TOKENISH.test(n)) continue;
    await add(tokensIn, `header ${n}`, rq[n]);
  }

  // response
  const response = { names: Object.keys(rs).filter((n) => !NOISE_RESPONSE.test(n) && n !== 'set-cookie'), safe: {}, rels: [], www: '', setCookies: [], location: '' };
  for (const n of Object.keys(rs)) if (SAFE_RESPONSE.has(n)) response.safe[n] = cut(rs[n]);
  // only the kind of an ETag (weak or strong) and the type of a download are kept, not the values
  if (rs.etag) response.safe.etag = /^W\//.test(rs.etag) ? 'weak' : 'strong';
  if (rs['content-disposition']) response.safe['content-disposition'] = cut(rs['content-disposition'].split(';')[0].trim(), 20);
  if (rs.link) response.rels = [...rs.link.matchAll(/rel="?([\w-]+)"?/gi)].map((m) => m[1].toLowerCase());
  if (rs['www-authenticate']) response.www = cut(rs['www-authenticate'].split(/[\s,]/)[0], 20);
  if (rs.location) {
    try { response.location = new URL(rs.location, 'http://x').pathname; } catch { response.location = ''; }
  }
  for (const [name, value] of parseSetCookie(setCookie ?? rs['set-cookie'])) {
    response.setCookies.push(name);
    await add(tokensOut, `set-cookie ${name}`, value);
  }
  for (const n of Object.keys(rs)) {
    if (n === 'set-cookie' || NOT_A_TOKEN.test(n) || !TOKENISH.test(n)) continue;
    await add(tokensOut, `header ${n}`, rs[n]);
  }
  return { req: request, res: response, tokensIn, tokensOut };
}

const PAGE_PARAMS = /^(page|pages?_?(size|number|index)|per_?page|limit|offset|skip|take|cursor|after|before|start|count|size|pos)$/i;

/** What an endpoint shows about paging: query parameters, Link header relations, total count. -> ['query: page, limit', ...] */
export function paginationHints(ep) {
  const hints = [];
  const params = Object.keys(ep.query ?? {}).filter((n) => PAGE_PARAMS.test(n));
  if (params.length) hints.push(`query: ${params.join(', ')}`);
  const rels = Object.keys(ep.rels ?? {}).filter((r) => ['next', 'prev', 'previous', 'first', 'last'].includes(r));
  if (rels.length) hints.push(`Link header: ${rels.join(', ')}`);
  for (const [name, values] of Object.entries(ep.safeHeaders ?? {})) {
    if (/^response x-(total-count|page|per-page)$/.test(name)) hints.push(`${name.replace('response ', '')}: ${Object.keys(values).slice(0, 3).join(', ')}`);
  }
  return hints;
}

const values = (ep, name) => Object.keys(ep.safeHeaders?.[name] ?? {});
const names = (obj) => Object.keys(obj ?? {});

/**
 * What a developer wants to know about an endpoint, from its headers: [[label, text], ...]. Empty parts are left out.
 * Authentication, paging, rate limits, caching, CORS, versions, tracing, idempotency, compression and the server stack.
 */
export function devNotes(ep) {
  const notes = [];
  const add = (label, text) => { if (text) notes.push([label, text]); };

  const customAuth = names(ep.reqHeaders).filter((n) => n !== 'authorization' && TOKENISH.test(n) && !NOT_A_TOKEN.test(n));
  add('Authentication', [
    names(ep.auth).join(', '),
    names(ep.cookies).length ? `cookies: ${names(ep.cookies).join(', ')}` : '',
    customAuth.length ? `headers: ${customAuth.join(', ')}` : '',
  ].filter(Boolean).join('; '));
  add('Sets cookies', names(ep.setCookies).join(', '));
  add('Pagination', paginationHints(ep).join('; '));
  add('Rate limit', rateLimitHints(ep).join('; '));

  const caching = [
    values(ep, 'response cache-control')[0] && `cache-control: ${values(ep, 'response cache-control').join(' / ')}`,
    values(ep, 'response etag')[0] && `ETag (${values(ep, 'response etag')[0]})${names(ep.reqHeaders).includes('if-none-match') ? ', conditional requests used' : ''}`,
    values(ep, 'response last-modified')[0] && 'Last-Modified',
    values(ep, 'response expires')[0] && `expires: ${values(ep, 'response expires')[0]}`,
  ].filter(Boolean);
  add('Caching', caching.join('; '));

  const cors = ['allow-origin', 'allow-methods', 'allow-headers', 'allow-credentials', 'expose-headers']
    .map((n) => values(ep, `response access-control-${n}`)[0] && `${n}: ${values(ep, `response access-control-${n}`).join(', ')}`).filter(Boolean);
  add('CORS', cors.join('; '));

  const versions = [
    ...['x-api-version', 'api-version', 'accept-version'].map((n) => values(ep, `request ${n}`)[0] && `request ${n}: ${values(ep, `request ${n}`)[0]}`),
    ...['x-api-version', 'api-version'].map((n) => values(ep, `response ${n}`)[0] && `response ${n}: ${values(ep, `response ${n}`)[0]}`),
    values(ep, 'response deprecation')[0] && `deprecated (${values(ep, 'response deprecation')[0]})`,
    values(ep, 'response sunset')[0] && `sunset: ${values(ep, 'response sunset')[0]}`,
  ].filter(Boolean);
  add('Versions', versions.join('; '));

  const all = [...names(ep.reqHeaders), ...names(ep.resHeaders)];
  const tracing = [...new Set(all.filter((n) => /(request|correlation|trace|span|transaction)-?id$|^traceparent$|^tracestate$|^x-b3-/.test(n)))];
  add('Tracing ids', tracing.join(', '));
  add('Idempotency', names(ep.reqHeaders).includes('idempotency-key') ? 'Idempotency-Key header is sent' : '');

  const accept = values(ep, 'request accept')[0];
  const encoding = values(ep, 'response content-encoding')[0];
  add('Content', [accept && `accepts ${accept}`, encoding && `compressed with ${encoding}`, values(ep, 'response content-language')[0] && `language ${values(ep, 'response content-language')[0]}`].filter(Boolean).join('; '));
  add('Stack', [values(ep, 'response server')[0], values(ep, 'response x-powered-by')[0]].filter(Boolean).join(', '));
  add('Server timing', values(ep, 'response server-timing')[0]);
  const security = ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy'].filter((n) => values(ep, `response ${n}`)[0]);
  add('Security headers', security.join(', '));
  return notes;
}

/** Rate limit headers of an endpoint: ['x-ratelimit-limit: 60', ...] */
export function rateLimitHints(ep) {
  return Object.entries(ep.safeHeaders ?? {})
    .filter(([name]) => /^response (x-)?ratelimit|^response retry-after/.test(name))
    .map(([name, values]) => `${name.replace('response ', '')}: ${Object.keys(values).slice(0, 3).join(', ')}`);
}
