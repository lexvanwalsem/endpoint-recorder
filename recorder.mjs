// Pure logic of the Endpoint Recorder: group requests per endpoint, infer JSON schemas, render a report.
// No browser APIs here so it can be unit tested with node:test.

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 20;
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_LENGTH = 40;

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
  if (typeof body.operationName === 'string') return body.operationName;
  if (typeof body.method === 'string') return body.method;
  const p = body.params;
  if (p && typeof p === 'object' && typeof p.model === 'string' && typeof p.method === 'string') return `${p.model}.${p.method}`;
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

function tryJson(text, mime) {
  if (!text) return undefined;
  if (mime && !/json|javascript|text\/plain|graphql/i.test(mime) && !/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Add one finished request.
 * entry: { method, url, status, timeMs, reqText, reqMime, resText, resMime }
 */
export function addEntry(store, entry, { keepExamples = false } = {}) {
  const url = new URL(entry.url);
  const reqJson = tryJson(entry.reqText, entry.reqMime);
  const resJson = tryJson(entry.resText, entry.resMime);
  const hint = rpcHint(reqJson);
  const path = normalizePath(url.pathname);
  const key = `${entry.method} ${url.host}${path}${hint ? ` [${hint}]` : ''}`;

  const ep = (store.endpoints[key] ??= {
    key, method: entry.method, host: url.host, path, rpc: hint,
    count: 0, statuses: {}, timeSum: 0, timeMax: 0, query: {},
    req: null, res: null, firstSeen: new Date().toISOString(), lastSeen: null,
  });
  ep.count++;
  ep.lastSeen = new Date().toISOString();
  ep.statuses[entry.status] = (ep.statuses[entry.status] ?? 0) + 1;
  ep.timeSum += entry.timeMs ?? 0;
  ep.timeMax = Math.max(ep.timeMax, entry.timeMs ?? 0);
  for (const name of url.searchParams.keys()) ep.query[name] = (ep.query[name] ?? 0) + 1;
  if (reqJson !== undefined) mergeSchema((ep.req ??= newNode()), reqJson, { keepExamples });
  if (resJson !== undefined) mergeSchema((ep.res ??= newNode()), resJson, { keepExamples });
  return ep;
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

export function toMarkdown(store) {
  const eps = Object.values(store.endpoints).sort((a, b) => b.count - a.count);
  const lines = [`# Recorded endpoints (${eps.length})`, '', `Recording started ${store.started}.`, ''];
  for (const ep of eps) {
    lines.push(`## ${ep.method} ${ep.host}${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}`, '');
    lines.push(`- Calls: ${ep.count}, average ${Math.round(ep.timeSum / ep.count)} ms, max ${Math.round(ep.timeMax)} ms`);
    lines.push(`- Status codes: ${Object.entries(ep.statuses).map(([s, n]) => `${s} x${n}`).join(', ')}`);
    if (Object.keys(ep.query).length) lines.push(`- Query parameters: ${Object.entries(ep.query).map(([k, n]) => `${k} (${n})`).join(', ')}`);
    lines.push('');
    if (ep.req) lines.push('Request body', '', ...table(ep.req), '');
    if (ep.res) lines.push('Response body', '', ...table(ep.res), '');
  }
  return `${lines.join('\n')}\n`;
}
