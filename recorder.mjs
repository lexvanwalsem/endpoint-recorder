// Pure logic of Surveyor: group requests per endpoint, infer field structure, keep example calls, render a report.
// No browser APIs here so it can be unit tested with node:test.

import { TOKENISH, devNotes } from './headers.mjs';
import { buildRouteTree, detectPolling, describeFlow, endpointLabel, flowSentence, getSteps, isApiCall, routeTreeLines } from './flow.mjs';

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 20;
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_LENGTH = 40;
const MAX_SAMPLES = 3;
const SAMPLE_ARRAY_ITEMS = 3;
const SAMPLE_KEYS = 60;
const SAMPLE_STRING = 200;
const SAMPLE_TEXT = 4000;
const MAX_CALLS = 5000; // calls kept for the steps view
const MAX_INDEX = 3000; // id-like values remembered for the data flow
const MAX_FOUND = 200; // searchable values per endpoint
const MAX_LEAVES = 300; // values taken from one body
const FOUND_VALUE = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replace ids in a URL path by {id}: numbers, uuids, long hex strings and long random tokens. */
export function normalizePath(pathname) {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg) || UUID.test(seg) || /^[0-9a-f]{12,}$/i.test(seg)) return '{id}';
      if (/^[A-Za-z0-9_-]{22,}$/.test(seg) && /\d/.test(seg)) return '{id}';
      return seg;
    })
    .join('/');
}

/** JSON-RPC and GraphQL share one URL; the body says what is called. Returns a short hint or ''. */
export function rpcHint(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  // Odoo and similar: { method: 'call', params: { model, method } } - the inner call is the interesting part
  const p = body.params;
  if (p && typeof p === 'object' && typeof p.model === 'string' && typeof p.method === 'string') return `${p.model}.${p.method}`;
  if (typeof body.operationName === 'string') return body.operationName;
  if (typeof body.method === 'string') return body.method;
  return '';
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function newNode() {
  return { n: 0, types: {}, examples: [], children: {}, items: null };
}

/** Merge one JSON value into a schema node. */
export function mergeSchema(node, value, { keepExamples = false, depth = 0 } = {}) {
  const type = typeOf(value);
  node.n++;
  node.types[type] = (node.types[type] ?? 0) + 1;
  if (type === 'object' && depth < MAX_DEPTH) {
    for (const [key, child] of Object.entries(value)) {
      node.children[key] ??= newNode();
      mergeSchema(node.children[key], child, { keepExamples, depth: depth + 1 });
    }
  } else if (type === 'array' && depth < MAX_DEPTH) {
    node.items ??= newNode();
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) mergeSchema(node.items, item, { keepExamples, depth: depth + 1 });
  } else if (keepExamples && type !== 'object' && type !== 'array' && node.examples.length < MAX_EXAMPLES) {
    const text = String(value).slice(0, MAX_EXAMPLE_LENGTH);
    if (!node.examples.includes(text)) node.examples.push(text);
  }
}

/** Flatten a schema to rows { path, types, presence (0..1), examples }. */
export function flatten(node, path = '$', parentN = node.n) {
  const rows = [{ path, types: Object.keys(node.types), presence: parentN ? node.n / parentN : 1, examples: node.examples }];
  for (const [key, child] of Object.entries(node.children)) rows.push(...flatten(child, `${path}.${key}`, node.n));
  if (node.items) rows.push(...flatten(node.items, `${path}[]`, node.items.n));
  return rows;
}

export function createStore() {
  // steps: what the user marked while recording; calls: one compact record per call (no bodies);
  // valueIndex: id-like values seen in responses; chains: where such a value was used again in a later request
  return { endpoints: {}, started: new Date().toISOString(), steps: [], calls: [], callSeq: 0, valueIndex: {}, chains: {} };
}

/** Mark a step ("opened a ticket"). Calls recorded from now on belong to it. Returns the step index. */
export function markStep(store, label) {
  const steps = (store.steps ??= []);
  steps.push({ label: String(label ?? '').trim().slice(0, 100) || `Step ${steps.length + 1}`, at: new Date().toISOString() });
  return steps.length - 1;
}

/** 'application/json; charset=utf-8' -> 'application/json'. Missing -> '(none)'. */
export function normalizeMime(mime) {
  return String(mime ?? '').split(';')[0].trim().toLowerCase() || '(none)';
}

/**
 * Classify a body.
 * -> { kind: 'json', value } | { kind: 'form', value } (both have fields) | { kind: 'text', text } | undefined (nothing readable)
 */
export function parseBody(text, mime) {
  if (!text) return undefined;
  const m = normalizeMime(mime);
  if (m === 'application/x-www-form-urlencoded') {
    const value = {};
    for (const [k, v] of new URLSearchParams(text)) value[k] = k in value ? [].concat(value[k], v) : v;
    return { kind: 'form', value };
  }
  if (/json|graphql/.test(m) || (/^\s*[[{]/.test(text) && (m === '(none)' || /text|javascript/.test(m)))) {
    try {
      return { kind: 'json', value: JSON.parse(text) };
    } catch { /* not valid JSON: keep it as text below when the type allows */ }
  }
  if (/xml|html|^text\/|javascript|csv|yaml|json|graphql/.test(m) || m === '(none)') return { kind: 'text', text };
  return undefined;
}

/**
 * The root fields of a GraphQL query: `{ me { id } orders(first: 5) { id } ping }` -> ['me', 'orders', 'ping'].
 * Aliases give the real field (`a: user(id: 1)` -> 'user'). A simple scanner, not a full parser.
 */
export function graphqlFields(query) {
  if (typeof query !== 'string') return [];
  const src = query.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const names = [];
  let depth = 0;
  let paren = 0;
  let expectName = false;
  for (let i = src.indexOf('{'); i >= 0 && i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') paren++;
    if (ch === ')') { paren--; continue; }
    if (paren > 0) continue;
    if (ch === '{') { depth++; expectName = depth === 1; continue; }
    if (ch === '}') { depth--; if (depth === 0) break; expectName = depth === 1; continue; }
    if (depth !== 1) continue;
    if (ch === '@') { const d = /^@[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); if (d) i += d[0].length - 1; continue; }
    if (ch === '.') { const s = /^\.\.\.\s*(on\s+)?[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); if (s) i += s[0].length - 1; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!word) continue;
    if (!expectName) { i += word[0].length - 1; continue; }
    let name = word[0];
    let end = i + name.length;
    const alias = /^\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(end));
    if (alias) { name = alias[1]; end += alias[0].length; }
    if (!name.startsWith('__')) names.push(name);
    i = end - 1;
    expectName = false;
    if (/^\s*[\s,]/.test(src.slice(end, end + 1) || ' ') && !/^\s*[({@:]/.test(src.slice(end))) expectName = true; // next word is a new field
  }
  return names;
}

/**
 * The operations inside one request: a JSON batch (an array of calls) or a GraphQL query with several root fields.
 * [] when the request holds a single operation.
 */
export function subOperations(value) {
  if (Array.isArray(value)) {
    if (value.length < 2) return [];
    return value.slice(0, 20).map((item, i) => {
      const named = item && typeof item === 'object' ? rpcHint(item) || (typeof item.operationName === 'string' ? item.operationName : '') || graphqlFields(item.query)[0] : '';
      return named || `#${i + 1}`;
    });
  }
  if (value && typeof value === 'object' && typeof value.query === 'string') {
    const fields = graphqlFields(value.query);
    return fields.length >= 2 ? fields.slice(0, 20) : [];
  }
  return [];
}

/** How requests prove who they are, per host: scheme, cookie names and header names. Values are never recorded. */
function authMarkdown(store, only) {
  const hosts = new Map();
  for (const ep of Object.values(store.endpoints)) {
    if (only && !only.includes(ep.key)) continue;
    const h = hosts.get(ep.host) ?? { auth: {}, cookies: new Set(), setCookies: new Set(), headers: new Set(), stack: new Set() };
    hosts.set(ep.host, h);
    for (const [k, n] of Object.entries(ep.auth ?? {})) h.auth[k] = (h.auth[k] ?? 0) + n;
    for (const c of Object.keys(ep.cookies ?? {})) h.cookies.add(c);
    for (const c of Object.keys(ep.setCookies ?? {})) h.setCookies.add(c);
    for (const n of Object.keys(ep.reqHeaders ?? {})) if (n !== 'authorization' && TOKENISH.test(n) && !/^(content-|accept|cache-)/.test(n)) h.headers.add(n);
    for (const k of ['response server', 'response x-powered-by']) for (const v of Object.keys(ep.safeHeaders?.[k] ?? {})) h.stack.add(v);
  }
  const rows = [...hosts].filter(([, h]) => Object.keys(h.auth).length || h.cookies.size || h.setCookies.size || h.headers.size);
  if (!rows.length) return [];
  const lines = ['# Authentication', '', 'How requests prove who they are: the scheme, cookies and headers (names only, values are never recorded).', ''];
  for (const [host, h] of rows) {
    const parts = [
      Object.keys(h.auth).length ? Object.entries(h.auth).map(([k, n]) => `${k} (${n} calls)`).join(', ') : '',
      h.cookies.size ? `cookies sent: ${[...h.cookies].join(', ')}` : '',
      h.setCookies.size ? `cookies set: ${[...h.setCookies].join(', ')}` : '',
      h.headers.size ? `headers: ${[...h.headers].join(', ')}` : '',
      h.stack.size ? `stack: ${[...h.stack].join(', ')}` : '',
    ].filter(Boolean);
    lines.push(`- ${host}: ${parts.join('; ')}`);
  }
  lines.push('');
  return lines;
}

/** The routing of the API as a tree in Markdown, with the steps that used each path. */
function routeMarkdown(store, only) {
  const trees = buildRouteTree(store, { keys: only, groups: getSteps(store) });
  if (!trees.length) return [];
  return ['# API map', '', 'The paths of the API as a tree: the methods seen on each path, how often, and the steps that used it.', '', ...routeTreeLines(trees), ''];
}

const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
/** Count a key, but keep at most `cap` different keys (a header set can be large). */
const bumpCapped = (counts, key, cap = 60) => { if (key in counts || Object.keys(counts).length < cap) bump(counts, key); };
/** Count a value under a header name: at most 6 different values per header, 40 header names. */
const bumpValue = (map, name, value) => {
  if (!(name in map) && Object.keys(map).length >= 40) return;
  const values = (map[name] ??= {});
  if (value in values || Object.keys(values).length < 6) bump(values, value);
};

/**
 * Add one finished request.
 * entry: { method, url, status, timeMs, type, size, reqText, reqMime, resText, resMime, binary, skipped }
 *   type: resource type ('XHR', 'Fetch', 'Document', ...), size: bytes over the wire,
 *   binary: the response is not text, skipped: why a body was not read (for example 'too large').
 */
export function addEntry(store, entry, { keepExamples = false } = {}) {
  const url = new URL(entry.url);
  const req = parseBody(entry.reqText, entry.reqMime);
  const res = parseBody(entry.resText, entry.resMime);
  const reqValue = req && req.kind !== 'text' ? req.value : undefined;
  const resValue = res && res.kind !== 'text' ? res.value : undefined;
  const hint = rpcHint(reqValue);
  const subs = subOperations(reqValue); // operations inside this one request (a batch, a GraphQL query with several fields)
  const path = normalizePath(url.pathname);
  const key = `${entry.method} ${url.host}${path}${hint ? ` [${hint}]` : ''}`;

  const ep = (store.endpoints[key] ??= {
    key, method: entry.method, host: url.host, path, rpc: hint, type: entry.type ?? '',
    count: 0, statuses: {}, timeSum: 0, timeMax: 0, sizeSum: 0, sizeCount: 0, sizeMax: 0, query: {},
    reqTypes: {}, resTypes: {}, req: null, res: null, firstSeen: new Date().toISOString(), lastSeen: null,
  });
  ep.reqTypes ??= {};
  ep.resTypes ??= {};
  ep.count++;
  ep.lastSeen = new Date().toISOString();
  ep.statuses[entry.status] = (ep.statuses[entry.status] ?? 0) + 1;
  ep.timeSum += entry.timeMs ?? 0;
  ep.timeMax = Math.max(ep.timeMax, entry.timeMs ?? 0);
  if (entry.size > 0) {
    ep.sizeSum = (ep.sizeSum ?? 0) + entry.size;
    ep.sizeCount = (ep.sizeCount ?? 0) + 1;
    ep.sizeMax = Math.max(ep.sizeMax ?? 0, entry.size);
  }
  for (const name of url.searchParams.keys()) ep.query[name] = (ep.query[name] ?? 0) + 1;
  if (entry.reqText) bump(ep.reqTypes, normalizeMime(entry.reqMime));
  if (entry.resMime) bump(ep.resTypes, normalizeMime(entry.resMime));
  if (subs.length) {
    ep.subs ??= {};
    for (const name of subs) if (name in ep.subs || Object.keys(ep.subs).length < 40) bump(ep.subs, name);
  }
  const hs = entry.headers; // a summary from headers.mjs: names, harmless values, fingerprints of tokens, never the values
  if (hs) {
    for (const k of ['reqHeaders', 'resHeaders', 'safeHeaders', 'auth', 'cookies', 'setCookies', 'rels']) ep[k] ??= {};
    for (const n of hs.req.names) bumpCapped(ep.reqHeaders, n);
    for (const n of hs.res.names) bumpCapped(ep.resHeaders, n);
    for (const [n, v] of Object.entries(hs.req.safe)) bumpValue(ep.safeHeaders, `request ${n}`, v);
    for (const [n, v] of Object.entries(hs.res.safe)) bumpValue(ep.safeHeaders, `response ${n}`, v);
    if (hs.req.auth) bump(ep.auth, hs.req.auth);
    if (hs.res.www) bump(ep.auth, `challenge: ${hs.res.www}`);
    for (const c of hs.req.cookies) bumpCapped(ep.cookies, c);
    for (const c of hs.res.setCookies) bumpCapped(ep.setCookies, c);
    for (const rel of hs.res.rels) bumpCapped(ep.rels, rel);
  }
  if (reqValue !== undefined) mergeSchema((ep.req ??= newNode()), reqValue, { keepExamples });
  if (resValue !== undefined) mergeSchema((ep.res ??= newNode()), resValue, { keepExamples });

  // Compact record of every call, for the steps view. Holds no bodies and no values.
  (store.calls ??= []).push({
    n: (store.callSeq = (store.callSeq ?? 0) + 1), at: Date.now(), s: Date.now() - Math.round(entry.timeMs ?? 0), step: store.steps?.length ? store.steps.length - 1 : null,
    key, status: entry.status, timeMs: Math.round(entry.timeMs ?? 0), size: entry.size, type: entry.type,
    subs: subs.length ? subs.slice(0, 10) : undefined,
  });
  if (store.calls.length > MAX_CALLS) store.calls.splice(0, store.calls.length - MAX_CALLS);

  if (keepExamples) {
    // A real example call: the full URL (with query values) and what came back, shortened to stay readable.
    const ctx = { cut: false };
    const sample = {
      at: new Date().toISOString(), url: entry.url, status: entry.status, timeMs: Math.round(entry.timeMs ?? 0),
      size: entry.size, type: entry.type, reqMime: entry.reqMime, resMime: entry.resMime, binary: entry.binary || undefined, skipped: entry.skipped,
    };
    if (req) { if (req.kind === 'text') sample.reqText = clip(req.text, ctx); else sample.req = shrink(req.value, ctx); }
    if (res) { if (res.kind === 'text') sample.resText = clip(res.text, ctx); else sample.res = shrink(res.value, ctx); }
    sample.cut = ctx.cut;
    (ep.samples ??= []).push(sample);
    if (ep.samples.length > MAX_SAMPLES) ep.samples.shift();

    // Values for "search by what you see" and for the data flow between calls.
    const resLeaves = [];
    const reqLeaves = [];
    if (resValue !== undefined) collectLeaves(resValue, '$', resLeaves);
    if (reqValue !== undefined) collectLeaves(reqValue, '$', reqLeaves);
    addFound(ep, 'res', resLeaves);
    addFound(ep, 'req', reqLeaves);
    const queryLeaves = [...url.searchParams].map(([k, v]) => [`?${k}`, v]);
    addFound(ep, 'url', queryLeaves);
    const headersOut = (hs?.tokensOut ?? []).map((t) => [t.where, `h:${t.hash}`]);
    const headersIn = (hs?.tokensIn ?? []).map((t) => [t.where, `h:${t.hash}`]);
    linkChains(store, key, url, queryLeaves, reqLeaves, headersIn); // before indexing this response, so a call never links to itself
    indexValues(store, key, [...resLeaves, ...headersOut]);
  }
  return ep;
}

/** Leaf values (strings and numbers) of a JSON value with their path, in the same notation as the field tables. */
function collectLeaves(value, path, out, depth = 0) {
  if (out.length >= MAX_LEAVES) return;
  if (Array.isArray(value)) {
    if (depth < MAX_DEPTH) for (const v of value.slice(0, MAX_ARRAY_ITEMS)) collectLeaves(v, `${path}[]`, out, depth + 1);
  } else if (value && typeof value === 'object') {
    if (depth < MAX_DEPTH) for (const [k, v] of Object.entries(value)) collectLeaves(v, `${path}.${k}`, out, depth + 1);
  } else if (typeof value === 'string' || typeof value === 'number') {
    out.push([path, value]);
  }
}

/** Remember which values were seen in an endpoint, so they can be found again by typing them. [side, path, value] */
function addFound(ep, side, leaves) {
  const found = (ep.found ??= []);
  const seen = new Set(found.map((f) => `${f[0]}|${f[1]}|${f[2]}`));
  for (const [path, value] of leaves) {
    if (found.length >= MAX_FOUND) return;
    const text = String(value).slice(0, FOUND_VALUE);
    const id = `${side}|${path}|${text}`;
    if (!text || seen.has(id)) continue;
    seen.add(id);
    found.push([side, path, text]);
  }
}

// A value is worth following when it looks like an identifier: a long token or code, or a number in a field called id/token/key/...
const ID_FIELD = /(^|[._\]])([a-z0-9]*_?ids?|uuid|token|key|code|ref|reference|number|nr|hash|session|slug)$/i;
const looksLikeToken = (s) => s.length >= 6 && s.length <= 100 && !/\s/.test(s) && (/\d/.test(s) || s.length >= 16);

function producedValue(path, value) {
  if (typeof value === 'string') return looksLikeToken(value) ? value : null;
  return Number.isInteger(value) && value >= 10 && ID_FIELD.test(path) ? String(value) : null;
}

function consumedValue(value) {
  const s = String(value);
  return /^\d{2,15}$/.test(s) || looksLikeToken(s) ? s : null;
}

function indexValues(store, key, leaves) {
  const index = (store.valueIndex ??= {});
  for (const [path, value] of leaves) {
    const v = producedValue(path, value);
    if (v === null) continue;
    delete index[`v:${v}`]; // re-insert so the newest producer is last
    index[`v:${v}`] = { key, path, n: store.callSeq };
  }
  const keys = Object.keys(index);
  if (keys.length > MAX_INDEX) for (const k of keys.slice(0, keys.length - MAX_INDEX)) delete index[k];
}

/** If this request carries a value an earlier response produced, record that link (producer field -> where it is used here). */
function linkChains(store, key, url, queryLeaves, bodyLeaves, extraUsed = []) {
  const index = store.valueIndex ?? {};
  const used = [];
  for (const seg of url.pathname.split('/')) {
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { /* keep raw */ }
    used.push(['path', decoded]);
  }
  for (const [name, value] of queryLeaves) used.push([`query ${name.replace(/^\?/, '')}`, value]);
  for (const [path, value] of bodyLeaves) used.push([`body ${path}`, value]);
  for (const [where, value] of extraUsed) used.push([where, value]);
  for (const [where, value] of used) {
    const v = consumedValue(value);
    const from = v === null ? undefined : index[`v:${v}`];
    if (!from || from.key === key) continue;
    const id = `${from.key} ${from.path} -> ${key} ${where}`;
    const chain = ((store.chains ??= {})[id] ??= { from, to: { key, where }, count: 0, example: v.startsWith('h:') ? 'a token (the value is not stored)' : v.slice(0, 40), pairs: [] });
    chain.count++;
    if (from.n !== undefined && (chain.pairs ??= []).length < 30) chain.pairs.push([from.n, store.callSeq]);
  }
}

function clip(text, ctx) {
  if (text.length <= SAMPLE_TEXT) return text;
  ctx.cut = true;
  return `${text.slice(0, SAMPLE_TEXT)}...`;
}

/** Shorten a JSON value for display: first 3 array items, 60 keys, strings of 200 characters, depth 8. Sets ctx.cut when something was left out. */
export function shrink(value, ctx = { cut: false }, depth = 0) {
  if (Array.isArray(value)) {
    if (value.length > SAMPLE_ARRAY_ITEMS) ctx.cut = true;
    return value.slice(0, SAMPLE_ARRAY_ITEMS).map((v) => shrink(v, ctx, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= MAX_DEPTH) { ctx.cut = true; return '...'; }
    const entries = Object.entries(value);
    if (entries.length > SAMPLE_KEYS) ctx.cut = true;
    return Object.fromEntries(entries.slice(0, SAMPLE_KEYS).map(([k, v]) => [k, shrink(v, ctx, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > SAMPLE_STRING) {
    ctx.cut = true;
    return `${value.slice(0, SAMPLE_STRING)}...`;
  }
  return value;
}

/** '1.4 MB', '830 B' */
export function formatBytes(n) {
  if (!(n > 0)) return '-';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const esc = (s) => String(s).replaceAll('|', '\\|');

function table(node) {
  const rows = flatten(node).slice(0, 300);
  const out = ['| Field | Type | Present | Examples |', '|---|---|---|---|'];
  for (const r of rows) {
    out.push(`| ${esc(r.path)} | ${esc(r.types.join(' / '))} | ${Math.round(r.presence * 100)}% | ${esc(r.examples.join(', '))} |`);
  }
  return out;
}

function stepsMarkdown(store, only) {
  const manual = (store.steps?.length ?? 0) > 0;
  const groups = getSteps(store);
  if (!groups.length) return [];
  const flow = describeFlow(store, groups, only);
  const lines = ['# Steps', '', manual
    ? 'The API calls made after each step you marked.'
    : 'Steps detected automatically: a pause in the API traffic or a page navigation starts a new step.', ''];
  for (const { group: g, needs, inner, gives } of flow) {
    lines.push(`## ${g.index === null ? g.label : `Step ${g.index + 1}: ${g.label}`}`, '');
    const perKey = new Map();
    for (const c of g.calls.filter(isApiCall)) if (store.endpoints[c.key] && (!only || only.includes(c.key))) perKey.set(c.key, (perKey.get(c.key) ?? 0) + 1);
    if (!perKey.size) lines.push('- (no API calls)');
    for (const [key, n] of perKey) lines.push(`- ${endpointLabel(store.endpoints[key])}${n > 1 ? ` x${n}` : ''}`);
    lines.push('');
    if (needs.length) lines.push('Needs:', ...needs.map((e) => `- ${flowSentence(store, 'needs', e)}`), '');
    if (inner.length) lines.push('Within this step:', ...inner.map((e) => `- ${flowSentence(store, 'inner', e)}`), '');
    if (gives.length) lines.push('Passes on:', ...gives.map((e) => `- ${flowSentence(store, 'gives', e)}`), '');
  }
  const polling = [...detectPolling(store)].filter(([key]) => store.endpoints[key] && (!only || only.includes(key)));
  if (polling.length) {
    lines.push('## Background calls', '', 'Called again and again at a regular interval, so left out of the steps.', '');
    for (const [key, p] of polling) lines.push(`- ${endpointLabel(store.endpoints[key])} about every ${Math.round(p.intervalMs / 1000)} s (${p.count} calls)`);
    lines.push('');
  }
  return lines;
}

function flowMarkdown(store, only) {
  const ok = (key) => store.endpoints[key] && (!only || only.includes(key));
  const chains = Object.values(store.chains ?? {}).filter((c) => ok(c.from.key) && ok(c.to.key)).sort((a, b) => b.count - a.count);
  if (!chains.length) return [];
  const lines = ['# Data flow', '', 'A value returned by one call and used again in a later call.', ''];
  for (const c of chains) {
    lines.push(`- ${endpointLabel(store.endpoints[c.from.key])} returns \`${c.from.path}\`, used in ${endpointLabel(store.endpoints[c.to.key])} (${c.to.where}), ${c.count}x, for example \`${c.example}\``);
  }
  lines.push('');
  return lines;
}

const counts = (obj) => Object.entries(obj ?? {}).map(([k, n]) => `${k} x${n}`).join(', ');

/** Markdown report. `only` (optional): array of endpoint keys to include. */
export function toMarkdown(store, only) {
  const eps = Object.values(store.endpoints).filter((ep) => !only || only.includes(ep.key)).sort((a, b) => b.count - a.count);
  const lines = [`# Recorded endpoints (${eps.length})`, '', `Recording started ${store.started}.`, '', ...routeMarkdown(store, only), ...authMarkdown(store, only), ...stepsMarkdown(store, only), ...flowMarkdown(store, only)];
  for (const ep of eps) {
    lines.push(`## ${ep.method} ${ep.host}${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}`, '');
    lines.push(`- Calls: ${ep.count}, average ${Math.round(ep.timeSum / ep.count)} ms, max ${Math.round(ep.timeMax)} ms`);
    if (ep.sizeCount) lines.push(`- Transfer size: average ${formatBytes(ep.sizeSum / ep.sizeCount)}, max ${formatBytes(ep.sizeMax)}`);
    lines.push(`- Status codes: ${counts(ep.statuses)}`);
    if (ep.type) lines.push(`- Request type: ${ep.type}`);
    if (Object.keys(ep.reqTypes ?? {}).length) lines.push(`- Request content types: ${counts(ep.reqTypes)}`);
    if (Object.keys(ep.resTypes ?? {}).length) lines.push(`- Response content types: ${counts(ep.resTypes)}`);
    if (Object.keys(ep.subs ?? {}).length) lines.push(`- Contains sub-calls: ${counts(ep.subs)}`);
    if (Object.keys(ep.query).length) lines.push(`- Query parameters: ${Object.entries(ep.query).map(([k, n]) => `${k} (${n})`).join(', ')}`);
    for (const [label, text] of devNotes(ep)) lines.push(`- ${label}: ${text}`);
    lines.push('');
    for (const s of (ep.samples ?? []).slice(-2).reverse()) {
      lines.push(`Example call: \`${ep.method} ${s.url}\` -> ${s.status} (${s.timeMs} ms${s.size ? `, ${formatBytes(s.size)}` : ''})${s.cut ? ', shortened' : ''}`, '');
      if (s.req !== undefined) lines.push('Request', '', '```json', JSON.stringify(s.req, null, 2), '```', '');
      if (s.reqText !== undefined) lines.push('Request (text)', '', '```', s.reqText, '```', '');
      if (s.res !== undefined) lines.push('Response', '', '```json', JSON.stringify(s.res, null, 2), '```', '');
      if (s.resText !== undefined) lines.push('Response (text)', '', '```', s.resText, '```', '');
      if (s.binary) lines.push(`Response is binary (${s.resMime ?? 'unknown type'}), not shown.`, '');
      if (s.skipped) lines.push(`Response body not read: ${s.skipped}.`, '');
    }
    if (ep.req) lines.push('Request fields', '', ...table(ep.req), '');
    if (ep.res) lines.push('Response fields', '', ...table(ep.res), '');
  }
  return `${lines.join('\n')}\n`;
}
