// Steps and flow: group the recorded calls into steps (marked by the user or detected automatically), name what each step
// does and explain which values travel from one step to the next. Pure logic, no browser APIs, unit tested.

export const endpointLabel = (ep) => `${ep.method} ${ep.host}${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}`;
const shortLabel = (ep) => `${ep.method} ${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}`;
export const isApiCall = (c) => !c.type || c.type === 'XHR' || c.type === 'Fetch';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const GAP_MS = 1500; // a pause in the API traffic longer than this starts a new step
const MAX_NAVS = 500;

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
    .filter((c) => isApiCall(c) && !polling.has(c.key) && store.endpoints[c.key])
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

const stepName = (index) => (index === null ? 'the start' : `step ${index + 1}`);

/** One flow edge as a sentence. kind: 'needs' | 'inner' | 'gives'. */
export function flowSentence(store, kind, e) {
  const from = shortLabel(store.endpoints[e.from.key]);
  const to = shortLabel(store.endpoints[e.to.key]);
  if (kind === 'needs') return `\`${e.to.where}\` of ${to} comes from ${stepName(e.fromStep)}: ${from} returns \`${e.from.path}\` (for example \`${e.example}\`)`;
  if (kind === 'gives') return `\`${e.from.path}\` of ${from} is used in ${stepName(e.toStep)}: ${to} (${e.to.where})`;
  return `${from} returns \`${e.from.path}\`, used in ${to} (${e.to.where})`;
}
