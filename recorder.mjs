// Pure logic of the Endpoint Recorder: group requests per endpoint, infer field structure, keep example calls, render a report.
// No browser APIs here so it can be unit tested with node:test.

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 20;
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_LENGTH = 40;
const MAX_SAMPLES = 3;
const SAMPLE_ARRAY_ITEMS = 3;
const SAMPLE_KEYS = 60;
const SAMPLE_STRING = 200;
const SAMPLE_TEXT = 4000;

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
  return { endpoints: {}, started: new Date().toISOString() };
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

const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };

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
  if (reqValue !== undefined) mergeSchema((ep.req ??= newNode()), reqValue, { keepExamples });
  if (resValue !== undefined) mergeSchema((ep.res ??= newNode()), resValue, { keepExamples });

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
  }
  return ep;
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

const counts = (obj) => Object.entries(obj ?? {}).map(([k, n]) => `${k} x${n}`).join(', ');

/** Markdown report. `only` (optional): array of endpoint keys to include. */
export function toMarkdown(store, only) {
  const eps = Object.values(store.endpoints).filter((ep) => !only || only.includes(ep.key)).sort((a, b) => b.count - a.count);
  const lines = [`# Recorded endpoints (${eps.length})`, '', `Recording started ${store.started}.`, ''];
  for (const ep of eps) {
    lines.push(`## ${ep.method} ${ep.host}${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}`, '');
    lines.push(`- Calls: ${ep.count}, average ${Math.round(ep.timeSum / ep.count)} ms, max ${Math.round(ep.timeMax)} ms`);
    if (ep.sizeCount) lines.push(`- Transfer size: average ${formatBytes(ep.sizeSum / ep.sizeCount)}, max ${formatBytes(ep.sizeMax)}`);
    lines.push(`- Status codes: ${counts(ep.statuses)}`);
    if (ep.type) lines.push(`- Request type: ${ep.type}`);
    if (Object.keys(ep.reqTypes ?? {}).length) lines.push(`- Request content types: ${counts(ep.reqTypes)}`);
    if (Object.keys(ep.resTypes ?? {}).length) lines.push(`- Response content types: ${counts(ep.resTypes)}`);
    if (Object.keys(ep.query).length) lines.push(`- Query parameters: ${Object.entries(ep.query).map(([k, n]) => `${k} (${n})`).join(', ')}`);
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
