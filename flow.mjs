// Steps and flow: group the recorded calls into steps (marked by the user or detected automatically), name what each step
// does and explain which values travel from one step to the next. Pure logic, no browser APIs, unit tested.

export const endpointLabel = (ep) => `${ep.method} ${ep.host}${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}`;
const shortLabel = (ep) => `${ep.method} ${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}`;
export const isApiCall = (c) => !c.type || c.type === 'XHR' || c.type === 'Fetch';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const GAP_MS = 1500; // a pause in the API traffic longer than this starts a new step
const MAX_NAVS = 500;

// Well-known analytics and monitoring services. Their calls say nothing about how the system works, so they are left out of the steps.
const TRACKERS = /(^|\.)(clarity\.ms|sentry\.io|sentry-cdn\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|hotjar\.(com|io)|segment\.(io|com)|mixpanel\.com|amplitude\.com|newrelic\.com|nr-data\.net|datadoghq\.com|bugsnag\.com|fullstory\.com|plausible\.io|posthog\.com|logrocket\.(com|io))$/i;
export const isTracker = (host) => TRACKERS.test(String(host).replace(/:\d+$/, ''));

/** Navigations of the recorded tab (page loads and route changes). They start a new step. */
export function addNav(store, { url, at = Date.now() }) {
  const navs = (store.navs ??= []);
  navs.push({ url: String(url).slice(0, 300), at });
  if (navs.length > MAX_NAVS) navs.splice(0, navs.length - MAX_NAVS);
}

/** The recorded calls grouped by the steps the user marked. [] when no step was marked. */
export function groupSteps(store) {
  const steps = store.steps ?? [];
  if (!steps.length) return [];
  const calls = store.calls ?? [];
  const groups = steps.map((s, i) => ({ index: i, label: s.label, at: s.at, calls: calls.filter((c) => c.step === i) }));
  const before = calls.filter((c) => c.step === null || c.step === undefined);
  if (before.length) groups.unshift({ index: null, label: 'Before the first step', at: null, calls: before });
  return groups;
}

/** Endpoints called again and again at a regular interval (polling): Map key -> { count, intervalMs }. */
export function detectPolling(store) {
  const starts = new Map();
  for (const c of store.calls ?? []) {
    if (!isApiCall(c)) continue;
    const list = starts.get(c.key) ?? [];
    list.push(c.s ?? c.at);
    starts.set(c.key, list);
  }
  const polling = new Map();
  for (const [key, times] of starts) {
    if (times.length < 4) continue;
    times.sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    if (mean >= 3000 && mean <= 180_000 && sd / mean < 0.35) polling.set(key, { count: times.length, intervalMs: Math.round(mean) });
  }
  return polling;
}

const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').trim().toLowerCase();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const singular = (s) => (/ies$/.test(s) ? s.replace(/ies$/, 'y') : /(ss|us)$/.test(s) ? s : s.replace(/s$/, ''));
const VERBISH = /^(get|set|add|update|delete|remove|create|list|search|save|load|find|fetch|send|close|open|check|is|has|log(in|out)|sign|register|upload|download|export|import)/i;

/** A short plain-language name for what a call does, from its method and path: "Close ticket", "List tickets". */
export function describeCall(ep) {
  if (ep.rpc) return ep.rpc;
  const segs = ep.path.split('/').filter((s) => s && !/^(api|rest|v\d+)$/i.test(s));
  const last = segs.at(-1) ?? '';
  const prev = segs.at(-2) ?? '';
  const isId = (s) => s === '{id}';
  if (isId(last)) return `${{ GET: 'Open', DELETE: 'Delete' }[ep.method] ?? 'Update'} ${singular(words(prev)) || 'item'}`;
  if (isId(prev) && last) {
    const thing = singular(words(segs.at(-3) ?? '')) || 'item';
    const name = words(last);
    if (/s$/.test(name) && !VERBISH.test(last)) return ep.method === 'GET' ? `Load ${name} of ${thing}` : `Add ${singular(name)} to ${thing}`;
    return `${cap(name)} ${thing}`;
  }
  if (VERBISH.test(last) || /[a-z][A-Z]/.test(last)) return `${cap(words(last))}${prev ? ` (${words(prev)})` : ''}`;
  const name = words(last) || 'root';
  if (ep.method === 'GET') return /s$/.test(name) ? `List ${name}` : `Load ${name}`;
  if (ep.method === 'POST') return `Create ${singular(name)}`;
  if (ep.method === 'DELETE') return `Delete ${singular(name)}`;
  return `Update ${singular(name)}`;
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.hash.startsWith('#/') ? u.hash : ''}` || '/';
  } catch {
    return String(url);
  }
}

function describeGroup(group, store) {
  const eps = group.calls.map((c) => store.endpoints[c.key]).filter(Boolean);
  if (!eps.length) return 'Background activity';
  // the calls that change something say what the step does; at most two are named, the rest is counted
  const distinct = [...new Map(eps.map((ep) => [ep.key, ep])).values()];
  const changing = distinct.filter((ep) => MUTATING.has(ep.method));
  const named = changing.length ? changing.slice(0, 2) : distinct.slice(0, 1);
  const more = distinct.length - named.length;
  return `${named.map(describeCall).join(' + ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/**
 * Steps without any marking: a pause in the API traffic (default 1.5 s) or a page navigation starts a new step.
 * Calls to endpoints that are polled at a regular interval are left out, they are background noise.
 * Same shape as groupSteps: [{ index, label, at, calls, auto: true }].
 */
export function detectSteps(store, { gapMs = GAP_MS } = {}) {
  const polling = detectPolling(store);
  const calls = (store.calls ?? [])
    .filter((c) => isApiCall(c) && !polling.has(c.key) && store.endpoints[c.key] && !isTracker(store.endpoints[c.key].host))
    .sort((a, b) => (a.s ?? a.at) - (b.s ?? b.at));
  const navs = [...(store.navs ?? [])].sort((a, b) => a.at - b.at);
  const groups = [];
  let cur = null;
  let curEnd = 0;
  let navIdx = 0;
  for (const c of calls) {
    const start = c.s ?? c.at;
    let nav = null;
    while (navIdx < navs.length && navs[navIdx].at <= start) nav = navs[navIdx++];
    if (!cur || nav || start - curEnd > gapMs) {
      cur = { index: groups.length, label: '', at: new Date(start).toISOString(), nav, calls: [], auto: true };
      groups.push(cur);
      curEnd = 0;
    }
    cur.calls.push(c);
    curEnd = Math.max(curEnd, c.at);
  }
  for (const g of groups) g.label = g.nav ? `Open ${pathOf(g.nav.url)}` : describeGroup(g, store);
  return groups;
}

/** The steps to show: the ones the user marked, otherwise the detected ones. source: 'manual' | 'auto' to force one. */
export function getSteps(store, source) {
  const manual = groupSteps(store);
  if (source === 'manual') return manual;
  if (source === 'auto') return detectSteps(store);
  return manual.length ? manual : detectSteps(store);
}

/** Values that travel between steps: [{ fromStep, toStep, from: { key, path }, to: { key, where }, example, count }]. */
export function flowEdges(store, groups) {
  const stepOf = new Map();
  for (const g of groups) for (const c of g.calls) stepOf.set(c.n, g.index);
  const edges = new Map();
  for (const chain of Object.values(store.chains ?? {})) {
    for (const [fromN, toN] of chain.pairs ?? []) {
      const fromStep = stepOf.get(fromN);
      const toStep = stepOf.get(toN);
      if (fromStep === undefined || toStep === undefined) continue;
      const id = `${fromStep}|${toStep}|${chain.from.key}|${chain.from.path}|${chain.to.key}|${chain.to.where}`;
      const edge = edges.get(id) ?? { fromStep, toStep, from: { key: chain.from.key, path: chain.from.path }, to: chain.to, example: chain.example, count: 0 };
      edge.count++;
      edges.set(id, edge);
    }
  }
  return [...edges.values()];
}

/**
 * The calls of one step as a tree: a call that used a value returned by an earlier call of the same step is nested under
 * it (the closest earlier producer). Returns [{ call, depth }] in reading order.
 */
export function nestCalls(store, calls) {
  const inStep = new Set(calls.map((c) => c.n));
  const parentOf = new Map();
  for (const chain of Object.values(store.chains ?? {})) {
    for (const [fromN, toN] of chain.pairs ?? []) {
      if (!inStep.has(fromN) || !inStep.has(toN) || fromN >= toN) continue;
      if (!parentOf.has(toN) || fromN > parentOf.get(toN)) parentOf.set(toN, fromN);
    }
  }
  const children = new Map();
  const roots = [];
  for (const c of calls) {
    const parent = parentOf.get(c.n);
    if (parent === undefined) roots.push(c);
    else children.set(parent, [...(children.get(parent) ?? []), c]);
  }
  const byStart = (a, b) => (a.s ?? a.at) - (b.s ?? b.at);
  roots.sort(byStart);
  const out = [];
  const walk = (c, depth) => {
    out.push({ call: c, depth });
    for (const child of (children.get(c.n) ?? []).sort(byStart)) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

/** Per step: what it needs from earlier steps, what happens inside it and what it passes on. Lists of flow edges. */
export function describeFlow(store, groups, only) {
  const ok = (key) => store.endpoints[key] && (!only || only.includes(key));
  const edges = flowEdges(store, groups).filter((e) => ok(e.from.key) && ok(e.to.key));
  return groups.map((group) => ({
    group,
    needs: edges.filter((e) => e.toStep === group.index && e.fromStep !== group.index),
    inner: edges.filter((e) => e.toStep === group.index && e.fromStep === group.index),
    gives: edges.filter((e) => e.fromStep === group.index && e.toStep !== group.index),
  }));
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const errorsOf = (ep) => Object.entries(ep.statuses ?? {}).filter(([s]) => Number(s) >= 400).reduce((n, [, c]) => n + (Number(c) || 0), 0);

function routeNode(name) {
  return { name, children: new Map(), endpoints: [] };
}

function finishRoute(node, stepsOf) {
  const children = [...node.children.values()].map((c) => finishRoute(c, stepsOf));
  children.sort((a, b) => (a.name === '{id}') - (b.name === '{id}') || a.name.localeCompare(b.name)); // {id} last
  const endpoints = node.endpoints
    .sort((a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method) || a.rpc.localeCompare(b.rpc))
    .map((ep) => ({ key: ep.key, method: ep.method, rpc: ep.rpc, count: ep.count, errors: errorsOf(ep), steps: [...(stepsOf.get(ep.key) ?? [])].sort((a, b) => a - b) }));
  let out = { name: node.name, endpoints, children, count: 0, errors: 0 };
  // a path segment without calls of its own and with one child is joined with it: /api/tickets instead of /api then /tickets
  while (!out.endpoints.length && out.children.length === 1 && out.name !== '') {
    const [only] = out.children;
    out = { ...only, name: `${out.name}/${only.name}` };
  }
  out.count = out.endpoints.reduce((n, e) => n + e.count, 0) + out.children.reduce((n, c) => n + c.count, 0);
  out.errors = out.endpoints.reduce((n, e) => n + e.errors, 0) + out.children.reduce((n, c) => n + c.errors, 0);
  return out;
}

/**
 * The internal routing of the API: the paths of all endpoints as a tree per host, with the methods seen on each path and
 * the steps (numbers) that used them. keys: only these endpoints. groups: steps, to say which steps used an endpoint.
 * -> [{ host, root: { name, endpoints: [{ key, method, rpc, count, errors, steps }], children: [...], count, errors } }]
 */
export function buildRouteTree(store, { keys, groups } = {}) {
  const stepsOf = new Map();
  for (const g of groups ?? []) {
    if (g.index === null) continue;
    for (const c of g.calls) stepsOf.set(c.key, (stepsOf.get(c.key) ?? new Set()).add(g.index + 1));
  }
  const hosts = new Map();
  for (const ep of Object.values(store.endpoints)) {
    if (keys && !keys.includes(ep.key)) continue;
    if (!hosts.has(ep.host)) hosts.set(ep.host, routeNode(''));
    let node = hosts.get(ep.host);
    for (const seg of ep.path.split('/').filter(Boolean)) {
      if (!node.children.has(seg)) node.children.set(seg, routeNode(seg));
      node = node.children.get(seg);
    }
    node.endpoints.push({ ...ep, rpc: ep.rpc ?? '' });
  }
  return [...hosts].map(([host, root]) => ({ host, root: finishRoute(root, stepsOf) })).sort((a, b) => b.root.count - a.root.count);
}

const routeCalls = (endpoints) => endpoints
  .map((e) => `${e.method}${e.rpc ? ` [${e.rpc}]` : ''} x${e.count}${e.steps.length ? ` (step ${e.steps.join(', ')})` : ''}`)
  .join(', ');

/** The route tree as indented Markdown lines. */
export function routeTreeLines(trees) {
  const lines = [];
  const walk = (node, depth) => {
    for (const child of node.children) {
      lines.push(`${'  '.repeat(depth)}- /${child.name}${child.endpoints.length ? `  ${routeCalls(child.endpoints)}` : ''}`);
      walk(child, depth + 1);
    }
  };
  for (const { host, root } of trees) {
    lines.push(`- ${host}${root.endpoints.length ? `  / ${routeCalls(root.endpoints)}` : ''}`);
    walk(root, 1);
  }
  return lines;
}

export const GRAPH = { nodeW: 240, nodeH: 60, gapX: 140, gapY: 24, pad: 28 };

/**
 * A node graph of how the calls link together: a node per endpoint, an edge when a value returned by one endpoint was used
 * in a request to another. Laid out in columns from left (where the data starts, such as the login) to right (what it leads to).
 * -> { nodes: [{ key, method, path, rpc, host, count, errors, steps, layer, x, y }],
 *      edges: [{ id, from, to, labels, count, example, back }], unlinked: [keys], width, height }
 */
export function buildGraph(store, { keys, groups } = {}) {
  const ok = (key) => store.endpoints[key] && (!keys || keys.includes(key));

  const firstN = new Map();
  for (const c of store.calls ?? []) if (!firstN.has(c.key) || c.n < firstN.get(c.key)) firstN.set(c.key, c.n);
  const order = (key) => firstN.get(key) ?? Infinity;

  const edgeMap = new Map();
  for (const c of Object.values(store.chains ?? {})) {
    if (!ok(c.from.key) || !ok(c.to.key) || c.from.key === c.to.key) continue;
    const id = `${c.from.key}>${c.to.key}`;
    const e = edgeMap.get(id) ?? { id, from: c.from.key, to: c.to.key, labels: [], count: 0, example: c.example, back: false };
    const label = `${c.from.path} -> ${c.to.where}`;
    if (!e.labels.includes(label) && e.labels.length < 4) e.labels.push(label);
    e.count += c.count;
    edgeMap.set(id, e);
  }
  const edges = [...edgeMap.values()];

  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodeKeys = [...linked].sort((a, b) => order(a) - order(b));
  const unlinked = Object.keys(store.endpoints).filter((k) => ok(k) && !linked.has(k)).sort((a, b) => order(a) - order(b));

  // a link that points back to an endpoint still on the path being followed would make a loop: it is drawn, not used for the layout
  const out = new Map(nodeKeys.map((k) => [k, []]));
  for (const e of edges) out.get(e.from).push(e);
  const state = new Map();
  const visit = (u) => {
    state.set(u, 1);
    for (const e of out.get(u)) {
      if (state.get(e.to) === 1) e.back = true;
      else if (!state.has(e.to)) visit(e.to);
    }
    state.set(u, 2);
  };
  for (const k of nodeKeys) if (!state.has(k)) visit(k);

  // column = the longest chain of links leading to the node
  const layer = new Map(nodeKeys.map((k) => [k, 0]));
  for (let i = 0; i < nodeKeys.length; i++) {
    for (const e of edges) if (!e.back) layer.set(e.to, Math.max(layer.get(e.to), layer.get(e.from) + 1));
  }
  const columns = [];
  for (const k of nodeKeys) (columns[layer.get(k)] ??= []).push(k);
  for (let c = 0; c < columns.length; c++) columns[c] ??= [];

  // within a column: order by the average position of the neighbours, to cross fewer lines
  const pos = new Map();
  const place = () => columns.forEach((col) => col.forEach((k, i) => pos.set(k, i)));
  place();
  const neighbours = (k, dir) => edges.filter((e) => !e.back && (dir === 'in' ? e.to === k : e.from === k)).map((e) => pos.get(dir === 'in' ? e.from : e.to));
  const bary = (k, dir) => { const n = neighbours(k, dir); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : pos.get(k); };
  for (let sweep = 0; sweep < 4; sweep++) {
    const dir = sweep % 2 === 0 ? 'in' : 'out';
    const cols = dir === 'in' ? columns : [...columns].reverse();
    for (const col of cols) { col.sort((a, b) => bary(a, dir) - bary(b, dir) || order(a) - order(b)); place(); }
  }

  const { nodeW, nodeH, gapX, gapY, pad } = GRAPH;
  const tallest = Math.max(0, ...columns.map((c) => c.length));
  const stepsOf = new Map();
  for (const g of groups ?? []) {
    if (g.index === null) continue;
    for (const c of g.calls) stepsOf.set(c.key, (stepsOf.get(c.key) ?? new Set()).add(g.index + 1));
  }
  const nodes = [];
  columns.forEach((col, c) => {
    const offset = ((tallest - col.length) * (nodeH + gapY)) / 2;
    col.forEach((key, i) => {
      const ep = store.endpoints[key];
      nodes.push({
        id: key, key, method: ep.method, path: ep.path, rpc: ep.rpc ?? '', host: ep.host, count: ep.count, errors: errorsOf(ep),
        steps: [...(stepsOf.get(key) ?? [])].sort((a, b) => a - b), layer: c,
        x: pad + c * (nodeW + gapX), y: pad + offset + i * (nodeH + gapY),
      });
    });
  });
  return {
    nodes, edges, unlinked,
    width: pad * 2 + Math.max(1, columns.length) * nodeW + Math.max(0, columns.length - 1) * gapX,
    height: pad * 2 + tallest * nodeH + Math.max(0, tallest - 1) * gapY,
  };
}

/**
 * The same graph, drawn per step: a column per step with the API calls made in it, so the whole session is visible even when
 * few values are passed between calls. Lines are values passed between calls (also across steps); `sequence` is the order of
 * the steps. Calls to analytics services are left out.
 * -> { nodes: [{ id, key, ..., layer: column, x, y }], edges: [{ id, from, to, labels, count, example, same }],
 *      columns: [{ x, label, index, count }], sequence: [[from column, to column]], unlinked: [], width, height }
 */
export function buildStepGraph(store, { keys, groups } = {}) {
  const ok = (key) => store.endpoints[key] && (!keys || keys.includes(key)) && !isTracker(store.endpoints[key].host);
  const steps = (groups ?? []).filter((g) => g.index !== null);
  const { nodeW, nodeH, gapY, pad } = GRAPH;
  const colGap = 70;
  const head = 46;
  const nodes = [];
  const columns = [];
  const nodeIds = new Set();
  const stepOf = new Map();
  steps.forEach((g, col) => {
    const perKey = new Map();
    for (const c of g.calls) {
      stepOf.set(c.n, g.index);
      if (isApiCall(c) && ok(c.key)) perKey.set(c.key, (perKey.get(c.key) ?? 0) + 1);
    }
    const x = pad + col * (nodeW + colGap);
    columns.push({ x, label: g.label, index: g.index + 1, count: perKey.size });
    let row = 0;
    for (const [key, n] of perKey) {
      const ep = store.endpoints[key];
      const id = `${g.index}|${key}`;
      nodeIds.add(id);
      nodes.push({ id, key, method: ep.method, path: ep.path, rpc: ep.rpc ?? '', host: ep.host, count: n, errors: errorsOf(ep), steps: [g.index + 1], layer: col, x, y: pad + head + row * (nodeH + gapY) });
      row++;
    }
  });
  const edgeMap = new Map();
  for (const chain of Object.values(store.chains ?? {})) {
    for (const [fromN, toN] of chain.pairs ?? []) {
      const fs = stepOf.get(fromN);
      const ts = stepOf.get(toN);
      const from = `${fs}|${chain.from.key}`;
      const to = `${ts}|${chain.to.key}`;
      if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) continue;
      const id = `${from}>${to}`;
      const e = edgeMap.get(id) ?? { id, from, to, labels: [], count: 0, example: chain.example, back: false, same: fs === ts };
      const label = `${chain.from.path} -> ${chain.to.where}`;
      if (!e.labels.includes(label) && e.labels.length < 4) e.labels.push(label);
      e.count++;
      edgeMap.set(id, e);
    }
  }
  const tallest = Math.max(0, ...columns.map((c) => c.count));
  return {
    nodes, edges: [...edgeMap.values()], columns, unlinked: [],
    sequence: columns.slice(1).map((_, i) => [i, i + 1]),
    width: pad * 2 + Math.max(1, columns.length) * nodeW + Math.max(0, columns.length - 1) * colGap,
    height: pad * 2 + head + tallest * nodeH + Math.max(0, tallest - 1) * gapY,
    mode: 'steps',
  };
}

/** For one node: everything that leads to it, everything it leads to, and one path from where the data starts to it. */
export function lineage(graph, key) {
  const forward = new Map();
  const backward = new Map();
  for (const e of graph.edges) {
    if (e.back) continue;
    (forward.get(e.from) ?? forward.set(e.from, []).get(e.from)).push(e);
    (backward.get(e.to) ?? backward.set(e.to, []).get(e.to)).push(e);
  }
  const walk = (start, map, next) => {
    const seen = new Set([start]);
    const edgeIds = new Set();
    const queue = [start];
    while (queue.length) {
      const u = queue.shift();
      for (const e of map.get(u) ?? []) {
        edgeIds.add(e.id);
        if (!seen.has(next(e))) { seen.add(next(e)); queue.push(next(e)); }
      }
    }
    return { seen, edgeIds };
  };
  const up = walk(key, backward, (e) => e.from);
  const down = walk(key, forward, (e) => e.to);

  // one path from a start of the data to the node: always step back to the predecessor in the furthest column
  const layerOf = new Map(graph.nodes.map((n) => [n.id ?? n.key, n.layer]));
  const path = [key];
  let current = key;
  for (let guard = 0; guard < graph.nodes.length; guard++) {
    const preds = backward.get(current) ?? [];
    if (!preds.length) break;
    preds.sort((a, b) => layerOf.get(b.from) - layerOf.get(a.from) || b.count - a.count);
    current = preds[0].from;
    path.unshift(current);
  }
  return { keys: new Set([...up.seen, ...down.seen]), edgeIds: new Set([...up.edgeIds, ...down.edgeIds]), path };
}

const stepName = (index) => (index === null ? 'the start' : `step ${index + 1}`);

/** One flow edge as a sentence. kind: 'needs' | 'inner' | 'gives'. */
export function flowSentence(store, kind, e) {
  const from = shortLabel(store.endpoints[e.from.key]);
  const to = shortLabel(store.endpoints[e.to.key]);
  if (kind === 'needs') return `\`${e.to.where}\` of ${to} comes from ${stepName(e.fromStep)}: ${from} returns \`${e.from.path}\` (for example \`${e.example}\`)`;
  if (kind === 'gives') return `\`${e.from.path}\` of ${from} is used in ${stepName(e.toStep)}: ${to} (${e.to.where})`;
  return `${from} returns \`${e.from.path}\`, used in ${to} (${e.to.where})`;
}
