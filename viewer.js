// Full page view of the recording: search, filter, sort, per-endpoint detail and export.
import { createStore, flatten, formatBytes, toMarkdown } from './recorder.mjs';
import { devNotes } from './headers.mjs';
import { GRAPH, buildGraph, buildRouteTree, buildStepGraph, describeFlow, detectPolling, endpointLabel, getSteps, isApiCall, lineage, nestCalls } from './flow.mjs';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 1000;

let store = createStore();
const state = { q: '', method: '', host: '', type: '', sort: 'count', errorsOnly: false, withBody: false, selected: null, side: 'sample', sample: 0, fieldQ: '', mode: 'endpoints', step: undefined, stepSource: undefined, apiOnly: true, collapsed: new Set(), graphFocus: null, zoom: undefined, graphMode: undefined, apiList: true, methods: new Set(), hosts: new Set(), types: new Set() };

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el[k] = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const time = (iso) => (iso ? new Date(iso).toLocaleString() : '-');

/** Text with the search term highlighted (DOM nodes, never innerHTML). */
function highlight(text, term) {
  const t = String(text);
  if (!term) return t;
  const i = t.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return t;
  return h('span', {}, t.slice(0, i), h('mark', {}, t.slice(i, i + term.length)), t.slice(i + term.length));
}

// Searchable text per endpoint (paths and example values of all fields), cached until the call count changes.
const indexCache = new Map();
function searchText(ep) {
  const hit = indexCache.get(ep.key);
  if (hit && hit.count === ep.count) return hit.text;
  const rows = [...(ep.req ? flatten(ep.req) : []), ...(ep.res ? flatten(ep.res) : [])];
  const samples = (ep.samples ?? []).map((s) => `${s.url} ${JSON.stringify(s.req ?? '')} ${JSON.stringify(s.res ?? '')}`);
  const found = (ep.found ?? []).map((f) => `${f[1]} ${f[2]}`);
  const text = [ep.key, ...Object.keys(ep.query), ...rows.map((r) => `${r.path} ${r.examples.join(' ')}`), ...samples, ...found].join('\n').toLowerCase();
  indexCache.set(ep.key, { count: ep.count, text });
  return text;
}

const isApiType = (ep) => !ep.type || ep.type === 'XHR' || ep.type === 'Fetch';
const avg = (ep) => (ep.count ? ep.timeSum / ep.count : 0);
const hasError = (ep) => errorCount(ep) > 0;
const errorCount = (ep) => Object.entries(ep.statuses ?? {}).filter(([s]) => Number(s) >= 400).reduce((n, [, c]) => n + (Number(c) || 0), 0);

function visible() {
  const q = state.q.trim().toLowerCase();
  const sorters = {
    count: (a, b) => b.count - a.count,
    avg: (a, b) => avg(b) - avg(a),
    recent: (a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)),
    name: (a, b) => a.key.localeCompare(b.key),
  };
  return Object.values(store.endpoints)
    .filter((ep) => (!state.methods.size || state.methods.has(ep.method))
      && (!state.hosts.size || state.hosts.has(ep.host))
      && (!state.apiList || isApiType(ep))
      && (!state.types.size || state.types.has(ep.type || 'Unknown'))
      && (!state.errorsOnly || hasError(ep))
      && (!state.withBody || ep.req || ep.res)
      && (!q || searchText(ep).includes(q)))
    .sort(sorters[state.sort]);
}

/**
 * A filter you can tick several values in: a button that opens a list with a search field. An empty selection means "all".
 * counts: Map value -> number of endpoints. The list is not rebuilt while it is open, so it does not jump under the mouse.
 */
function renderMulti(id, noun, counts, selected) {
  const el = $(id);
  if (el.open) return;
  for (const v of [...selected]) if (!counts.has(v)) selected.delete(v); // a value that is gone cannot stay selected
  const label = () => (selected.size === 0 ? `All ${noun}` : selected.size === 1 ? [...selected][0] : `${selected.size} ${noun}`);
  const summary = h('summary', {}, h('span', {}, label()));
  const options = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const boxes = [];
  const list = h('div', { class: 'multilist' }, options.map(([value, n]) => {
    const box = h('input', { type: 'checkbox', checked: selected.has(value), onchange: (e) => {
      if (e.target.checked) selected.add(value); else selected.delete(value);
      summary.firstChild.textContent = label();
      render();
    } });
    boxes.push(box);
    return h('label', { class: 'multirow', 'data-value': String(value) }, box, h('span', { class: 'multiname' }, String(value)), h('span', { class: 'n' }, String(n)));
  }));
  const search = options.length > 8 ? h('input', {
    type: 'search', placeholder: `Filter ${noun}`,
    oninput: (e) => { for (const row of list.children) row.hidden = !row.dataset.value.toLowerCase().includes(e.target.value.toLowerCase()); },
  }) : null;
  const clear = h('button', { onclick: () => { selected.clear(); boxes.forEach((b) => { b.checked = false; }); summary.firstChild.textContent = label(); render(); } }, 'Clear');
  el.replaceChildren(summary, h('div', { class: 'multipanel' }, search, list, h('div', { class: 'multifoot' }, clear)));
}

const countBy = (list, f) => list.reduce((m, e) => m.set(f(e), (m.get(f(e)) ?? 0) + 1), new Map());

// a list is closed again when you click outside it
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.multi[open]')) if (!d.contains(e.target)) d.open = false;
});


function renderList(eps) {
  const list = $('list');
  if (!eps.length) {
    const none = !Object.keys(store.endpoints).length;
    list.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'big' }, none ? 'Nothing recorded yet' : 'No endpoints match'),
      none ? 'Open a tab, click the extension icon and press "Record this tab".' : 'Change or clear the filters above.'));
    return;
  }
  list.replaceChildren(...eps.map((ep) => h('div', {
    class: `item${ep.key === state.selected ? ' selected' : ''}`,
    onclick: () => pick(ep.key, matchLines(ep)[0]),
  },
  h('div', { class: 'top' },
    h('span', { class: `mpill ${ep.method}` }, ep.method),
    h('span', { class: 'path mono' }, highlight(ep.path, state.q.trim()), ep.rpc ? h('span', { class: 'rpc' }, ` ${ep.rpc}`) : null)),
  h('div', { class: 'meta' },
    `${ep.host} · ${plural(ep.count, 'call')} · ${Math.round(avg(ep))} ms`,
    ep.type && !['XHR', 'Fetch'].includes(ep.type) ? h('span', { class: 'pill' }, ep.type) : null,
    hasError(ep) ? h('span', { class: 'pill err' }, plural(errorCount(ep), 'error')) : null),
  ...matchLines(ep).map(matchRow))));
}

/** Values of this endpoint that contain the search text: [side, path, value]. */
function matchLines(ep) {
  const q = state.q.trim().toLowerCase();
  if (!q) return [];
  return (ep.found ?? []).filter((f) => f[2].toLowerCase().includes(q)).slice(0, 2);
}

const WHERE = { res: 'received', req: 'sent', url: 'query' };
const matchRow = ([side, path, value]) => h('div', { class: 'match mono' }, h('span', { class: 'where' }, WHERE[side]), `${path} = `, highlight(value, state.q.trim()));

/** Select an endpoint; with a search hit, open the matching field. */
function pick(key, hit) {
  if (state.mode === 'steps') setMode('endpoints');
  state.graphFocus = key;
  state.selected = key;
  state.sample = 0;
  state.fieldQ = hit ? hit[1] : '';
  if (hit && hit[0] !== 'url') state.side = hit[0];
  render();
}

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('#mode button')) b.classList.toggle('active', b.dataset.mode === mode);
}

function jumpTo(key) {
  pick(key, null);
}

/** Where the values of this endpoint come from and where they are used again. */
function flowBlock(ep) {
  const chains = Object.values(store.chains ?? {});
  const inputs = chains.filter((c) => c.to.key === ep.key && store.endpoints[c.from.key]);
  const outputs = chains.filter((c) => c.from.key === ep.key && store.endpoints[c.to.key]);
  if (!inputs.length && !outputs.length) return null;
  const link = (key) => h('span', { class: 'link', onclick: () => jumpTo(key) }, endpointLabel(store.endpoints[key]));
  const code = (t) => h('code', { class: 'mono' }, t);
  const note = (c) => h('span', { class: 'muted' }, ` e.g. ${c.example}, ${c.count}x`);
  return h('div', { class: 'flow' },
    h('div', { class: 'label' }, 'Data flow'),
    inputs.map((c) => h('div', { class: 'flowrow' }, h('span', { class: 'arrow' }, 'in'), code(c.to.where), ' comes from ', link(c.from.key), ' ', code(c.from.path), note(c))),
    outputs.map((c) => h('div', { class: 'flowrow' }, h('span', { class: 'arrow' }, 'out'), code(c.from.path), ' is used in ', link(c.to.key), ' ', code(c.to.where), note(c))));
}

const shortEndpoint = (ep) => `${ep.method} ${ep.path}${ep.rpc ? ` ${ep.rpc}` : ''}`;
const stepMarker = (g) => h('span', { class: g.index === null ? 'wp wp-start' : 'wp' }, g.index === null ? '' : String(g.index + 1));
const stepTitle = (g) => (g.index === null ? g.label : `Step ${g.index + 1}: ${g.label}`);

/** One value travelling between calls, as a row with links to the endpoints and steps involved. kind: 'needs' | 'inner' | 'gives'. */
function flowRow(kind, e) {
  const link = (key) => h('span', { class: 'link', onclick: () => jumpTo(key) }, shortEndpoint(store.endpoints[key]));
  const stepLink = (idx) => h('span', { class: 'link', onclick: () => { state.step = idx; render(); } }, idx === null ? 'the start' : `step ${idx + 1}`);
  const code = (t) => h('code', { class: 'mono' }, t);
  const note = h('span', { class: 'muted' }, ` e.g. ${e.example}, ${e.count}x`);
  if (kind === 'needs') return h('div', { class: 'flowrow' }, h('span', { class: 'arrow' }, 'needs'), code(e.to.where), ' of ', link(e.to.key), ' comes from ', stepLink(e.fromStep), ': ', link(e.from.key), ' returns ', code(e.from.path), note);
  if (kind === 'gives') return h('div', { class: 'flowrow' }, h('span', { class: 'arrow' }, 'passes on'), code(e.from.path), ' of ', link(e.from.key), ' is used in ', stepLink(e.toStep), ': ', link(e.to.key), ' (', e.to.where, ')', note);
  return h('div', { class: 'flowrow' }, h('span', { class: 'arrow' }, 'within'), link(e.from.key), ' returns ', code(e.from.path), ', used in ', link(e.to.key), ' (', e.to.where, ')', note);
}

const flowRows = (f) => [...f.needs.map((e) => flowRow('needs', e)), ...f.inner.map((e) => flowRow('inner', e)), ...f.gives.map((e) => flowRow('gives', e))];

function renderStepList() {
  const list = $('list');
  const groups = getSteps(store, state.stepSource);
  const polling = [...detectPolling(store)].filter(([key]) => store.endpoints[key]);
  const manual = (store.steps?.length ?? 0) > 0;
  if (!groups.length && !polling.length) {
    list.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'big' }, 'No steps yet'),
      'Surveyor finds steps by itself: a pause in the traffic or a page change starts a new one. You can also mark them yourself in the popup.'));
    return;
  }
  if (state.step !== 'overview' && state.step !== 'background' && !groups.some((g) => g.index === state.step)) state.step = 'overview';

  const source = state.stepSource ?? (manual ? 'manual' : 'auto');
  const toggle = manual ? h('div', { class: 'srcbar' }, h('div', { class: 'seg' },
    [['manual', 'Marked by you'], ['auto', 'Detected']].map(([id, label]) => h('button', {
      class: source === id ? 'active' : '', onclick: () => { state.stepSource = id; render(); },
    }, label)))) : null;

  const item = (id, extraClass, top, meta) => h('div', { class: `item${id === state.step ? ' selected' : ''}${extraClass}`, onclick: () => { state.step = id; render(); } },
    h('div', { class: 'top' }, ...top), h('div', { class: 'meta' }, meta));

  const note = h('div', { class: 'stepnote muted' }, 'A step is something you did (a click, a page change) and the API calls that followed it.');
  const overview = groups.length ? item('overview', '', [h('span', { class: 'path' }, 'Flow overview')], `${plural(groups.length, 'step')} and how they connect`) : null;
  const steps = groups.map((g, i) => item(g.index, i < groups.length - 1 ? ' route' : '', [stepMarker(g), h('span', { class: 'path' }, g.label)],
    `${plural(g.calls.filter(isApiCall).length, 'API call')}${g.at ? ` · ${new Date(g.at).toLocaleTimeString()}` : ''}${g.auto ? ' · detected' : ''}`));
  const background = polling.length ? item('background', '', [h('span', { class: 'path' }, 'Background calls')], `${plural(polling.length, 'endpoint')} repeated at a regular interval`) : null;
  list.replaceChildren(...[toggle, note, overview, ...steps, background].filter(Boolean));
}

function renderOverview(right, groups) {
  const flow = describeFlow(store, groups);
  const auto = groups.some((g) => g.auto);
  right.replaceChildren(h('div', { class: 'detail' },
    h('div', { class: 'title' }, h('h2', {}, 'Flow overview')),
    h('div', { class: 'sub muted' }, `${plural(groups.length, 'step')}${auto ? ', detected automatically from pauses and page changes' : ', marked by you'}. For each step: what it needs from earlier steps and what it passes on.`),
    flow.map((f) => {
      const keys = [...new Set(f.group.calls.map((c) => c.key))].filter((k) => store.endpoints[k]);
      const shown = keys.slice(0, 6).map((k) => shortEndpoint(store.endpoints[k])).join('  ·  ');
      return h('div', { class: 'ovstep' },
        h('div', { class: 'ovhead', onclick: () => { state.step = f.group.index; render(); } }, stepMarker(f.group), h('b', {}, f.group.label)),
        h('div', { class: 'ovcalls mono muted' }, shown + (keys.length > 6 ? `  ·  +${keys.length - 6} more` : '')),
        flowRows(f).length ? flowRows(f) : h('div', { class: 'muted' }, 'No values from other steps were recognised here.'));
    })));
}

function renderBackground(right) {
  const polling = [...detectPolling(store)].filter(([key]) => store.endpoints[key]);
  right.replaceChildren(h('div', { class: 'detail' },
    h('div', { class: 'title' }, h('h2', {}, 'Background calls')),
    h('div', { class: 'sub muted' }, 'These endpoints are called again and again at a regular interval. They are left out of the steps.'),
    h('div', { class: 'panel' }, h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Call', 'Interval', 'Calls'].map((t) => h('th', {}, t)))),
      h('tbody', {}, polling.map(([key, p]) => {
        const ep = store.endpoints[key];
        return h('tr', {},
          h('td', {}, h('span', { class: `mpill ${ep.method}` }, ep.method), ' ', h('span', { class: 'link mono', onclick: () => jumpTo(key) }, ep.path + (ep.rpc ? ` ${ep.rpc}` : '')), h('div', { class: 'muted' }, ep.host)),
          h('td', {}, `about every ${Math.round(p.intervalMs / 1000)} s`),
          h('td', {}, String(p.count)));
      })))))));
}

function renderStepDetail() {
  const right = $('right');
  const groups = getSteps(store, state.stepSource);
  if (state.step === 'overview' && groups.length) return renderOverview(right, groups);
  if (state.step === 'background') return renderBackground(right);
  const flow = describeFlow(store, groups).find((f) => f.group.index === state.step);
  if (!flow) { right.replaceChildren(h('div', { class: 'empty' })); return; }
  const g = flow.group;
  const calls = g.calls.filter((c) => (!state.apiOnly || isApiCall(c)) && store.endpoints[c.key]);
  const t0 = g.at ? Date.parse(g.at) : (g.calls[0]?.at ?? 0);
  const rows = flowRows(flow);
  const tree = nestCalls(store, calls);
  const nested = tree.some((t) => t.depth > 0);
  right.replaceChildren(h('div', { class: 'detail' },
    h('div', { class: 'title' }, stepMarker(g), h('h2', {}, g.label)),
    h('div', { class: 'sub muted' }, `${g.at ? `${time(g.at)} · ` : ''}${plural(calls.length, 'call')} shown${g.auto ? ' · detected automatically' : ''}`),
    h('div', { class: 'explain muted' }, `This is what the page did after something you did (a click or a page change).${nested ? ' A call shown indented used a value returned by the call above it.' : ''}`),
    rows.length ? h('div', { class: 'flow' }, h('div', { class: 'label' }, 'Flow'), rows) : null,
    h('div', { class: 'tools' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.apiOnly, onchange: (e) => { state.apiOnly = e.target.checked; render(); } }), ' API calls only (XHR and fetch)')),
    h('div', { class: 'panel' }, h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Time', 'Call', 'Status', 'Duration', 'Size', 'Type'].map((t) => h('th', {}, t)))),
      h('tbody', {}, tree.flatMap(({ call: c, depth }) => {
        const ep = store.endpoints[c.key];
        const main = h('tr', {},
          h('td', { class: 'mono' }, `+${Math.max(0, ((c.s ?? c.at) - t0) / 1000).toFixed(1)} s`),
          h('td', {}, depth ? h('span', { class: 'nest', style: `margin-left:${(depth - 1) * 20}px` }) : null, h('span', { class: `mpill ${ep.method}` }, ep.method), ' ', h('span', { class: 'link mono', onclick: () => jumpTo(c.key) }, ep.path + (ep.rpc ? ` ${ep.rpc}` : '')), h('div', { class: 'muted' }, ep.host)),
          h('td', {}, h('span', { class: `pill ${c.status >= 400 ? 'err' : 'ok'}` }, String(c.status))),
          h('td', {}, `${c.timeMs} ms`),
          h('td', {}, c.size ? formatBytes(c.size) : '-'),
          h('td', {}, c.type || '-'));
        return [main, ...subRows(c, depth)];
      })))))));
}

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el[k] = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}
const trunc = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}...` : text);

/** Select an endpoint without leaving the Map or Graph view. */
function selectHere(key) {
  state.selected = key;
  state.graphFocus = key;
  state.sample = 0;
  state.fieldQ = '';
  render();
}

/** The routing of the API as a tree: host, then the path segments, with the methods, counts and steps on each path. */
function renderMap(eps) {
  const list = $('list');
  if (!eps.length) { renderList(eps); return; }
  const trees = buildRouteTree(store, { keys: eps.map((e) => e.key), groups: getSteps(store, state.stepSource) });
  const rows = [];
  const pills = (endpoints) => endpoints.map((ep) => h('span', { class: 'mapep' },
    h('span', {
      class: `mpill ${ep.method}${ep.key === state.selected ? ' sel' : ''}`, title: `${ep.count} calls`,
      onclick: (e) => { e.stopPropagation(); selectHere(ep.key); },
    }, ep.method + (ep.rpc ? ` ${ep.rpc}` : '')),
    h('span', { class: 'muted small' }, `${ep.count}`),
    ep.errors ? h('span', { class: 'pill err' }, plural(ep.errors, 'error')) : null,
    ep.steps.slice(0, 4).map((n) => h('span', { class: 'wp mini', title: `used in step ${n}` }, String(n)))));
  const walk = (node, depth, prefix) => {
    for (const child of node.children) {
      const id = `${prefix}/${child.name}`;
      const hasKids = child.children.length > 0;
      const closed = state.collapsed.has(id);
      const toggle = () => { if (!hasKids) return; if (closed) state.collapsed.delete(id); else state.collapsed.add(id); render(); };
      rows.push(h('div', { class: 'mapnode', style: `padding-left:${10 + depth * 18}px` },
        h('span', { class: `caret${hasKids ? (closed ? ' closed' : ' open') : ' none'}`, onclick: toggle }),
        h('span', { class: 'mapname mono', onclick: toggle }, `/${child.name}`),
        pills(child.endpoints),
        closed ? h('span', { class: 'muted small' }, ` ${plural(child.count, 'call')} inside`) : null));
      if (hasKids && !closed) walk(child, depth + 1, id);
    }
  };
  for (const { host, root } of trees) {
    rows.push(h('div', { class: 'maphost' }, h('b', {}, host), h('span', { class: 'muted' }, ` ${plural(root.count, 'call')}`)));
    if (root.endpoints.length) rows.push(h('div', { class: 'mapnode', style: 'padding-left:10px' }, h('span', { class: 'caret none' }), h('span', { class: 'mapname mono' }, '/'), pills(root.endpoints)));
    walk(root, 0, host);
  }
  list.replaceChildren(h('div', { class: 'maphint muted' }, 'The paths of the API as a tree. The numbers are the steps that used a path.'), ...rows);
}

/**
 * A node graph of how the calls link together. Two layouts: by values (from the login to the data it leads to) or by steps
 * (a column per step with the calls made in it, so the whole session is visible even when few values are passed on).
 */
function renderGraph(eps) {
  const right = $('right');
  const keys = eps.map((e) => e.key);
  const groups = getSteps(store, state.stepSource);
  const valueGraph = buildGraph(store, { keys, groups });
  // when only a few calls pass values on, the step layout shows far more of the session
  const mode = state.graphMode ?? (valueGraph.nodes.length < 6 && groups.length > 1 ? 'steps' : 'values');
  const graph = mode === 'steps' ? buildStepGraph(store, { keys, groups }) : valueGraph;
  if (!graph.nodes.length) {
    right.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'big' }, mode === 'steps' ? 'No steps yet' : 'No links between calls yet'),
      mode === 'steps' ? 'Steps appear as soon as you have clicked around a little.' : 'The graph shows which value from one call is used in another. Record some activity with example data switched on, then come back.'));
    return;
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const focusNode = graph.nodes.find((n) => n.id === state.graphFocus) ?? graph.nodes.find((n) => n.key === state.graphFocus) ?? null;
  const focus = focusNode ? focusNode.id : null;
  const lin = focus ? lineage(graph, focus) : null;
  const available = Math.max(300, right.clientWidth - 56);
  const zoom = state.zoom ?? Math.max(0.7, Math.min(1, available / graph.width)); // never so small that it cannot be read
  const { nodeW, nodeH, pad } = GRAPH;
  const focusOn = (id) => { const n = byId.get(id); state.graphFocus = id; state.selected = n.key; render(); };

  const edgeEls = graph.edges.map((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const hi = lin?.edgeIds.has(e.id);
    const cls = `gedge${e.back ? ' back' : ''}${hi ? ' hi' : ''}${lin && !hi ? ' dim' : ''}`;
    let d;
    let mx;
    let my;
    if (e.same) { // two calls of one step: a straight line down or up the column
      const cx = a.x + nodeW / 2;
      const down = b.y > a.y;
      d = `M${cx} ${down ? a.y + nodeH : a.y} L${cx} ${down ? b.y : b.y + nodeH}`;
      mx = cx + 8;
      my = (a.y + b.y) / 2 + nodeH / 2;
    } else {
      const x1 = a.x + nodeW;
      const y1 = a.y + nodeH / 2;
      const x2 = b.x;
      const y2 = b.y + nodeH / 2;
      const dx = Math.max(60, Math.abs(x2 - x1) / 2);
      d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
      mx = (x1 + x2) / 2;
      my = (y1 + y2) / 2 - 6;
    }
    const els = [s('path', { class: cls, d, 'marker-end': hi ? 'url(#arrHi)' : 'url(#arr)' },
      s('title', {}, `${e.labels.join('\n')}\ne.g. ${e.example}, ${e.count}x`))];
    if (hi) els.push(s('text', { class: 'glabel', x: mx, y: my, 'text-anchor': 'middle' }, trunc(e.labels[0], 34) + (e.labels.length > 1 ? ` +${e.labels.length - 1}` : '')));
    return els;
  });

  const columnEls = (graph.columns ?? []).map((col) => s('g', {
    class: 'gcol', transform: `translate(${col.x} ${pad})`, onclick: (ev) => { ev.stopPropagation(); state.step = col.index - 1; setMode('steps'); render(); },
  },
  s('title', {}, `Step ${col.index}: ${col.label}\nClick to open this step`),
  s('rect', { class: 'ghead', width: nodeW, height: 30, rx: 8 }),
  s('text', { x: 12, y: 20 }, `${col.index}  ${trunc(col.label, 25)}`)));
  const sequenceEls = (graph.sequence ?? []).map(([i, j]) => {
    const y = pad + 15;
    return s('path', { class: 'gseq', d: `M${graph.columns[i].x + nodeW} ${y} L${graph.columns[j].x} ${y}`, 'marker-end': 'url(#arr)' });
  });

  const nodeEls = graph.nodes.map((n) => {
    const dim = lin && !lin.keys.has(n.id);
    const label = trunc(n.path + (n.rpc ? ` ${n.rpc}` : ''), 21);
    return s('g', { class: `gnode${n.id === focus ? ' sel' : ''}${dim ? ' dim' : ''}`, transform: `translate(${n.x} ${n.y})`, onclick: (e) => { e.stopPropagation(); focusOn(n.id); } },
      s('title', {}, `${n.method} ${n.host}${n.path}${n.rpc ? ` [${n.rpc}]` : ''}\n${n.count} calls`),
      s('rect', { class: 'box', width: nodeW, height: nodeH, rx: 12 }),
      s('g', { class: `gm ${n.method}` }, s('rect', { class: 'pill', x: 12, y: 11, width: 52, height: 22, rx: 6 }), s('text', { x: 38, y: 26, 'text-anchor': 'middle' }, n.method)),
      s('text', { class: 'gpath', x: 74, y: 27 }, label),
      s('text', { class: 'gmeta', x: 14, y: 49 }, `${trunc(n.host, 26)}  ·  ${plural(n.count, 'call')}`),
      mode === 'values' ? n.steps.slice(0, 3).map((num, i) => s('g', { class: 'gstep', transform: `translate(${nodeW - 16 - i * 22} 15)` }, s('circle', { r: 9 }), s('text', { y: 4, 'text-anchor': 'middle' }, String(num)))) : null,
      n.errors ? s('circle', { class: 'gerr', cx: nodeW - 12, cy: nodeH - 12, r: 5 }) : null);
  });

  const svg = s('svg', { class: 'graph', width: Math.round(graph.width * zoom), height: Math.round(graph.height * zoom), viewBox: `0 0 ${graph.width} ${graph.height}`, onclick: () => { state.graphFocus = null; render(); } },
    s('defs', {},
      s('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, s('path', { class: 'arrow-shape', d: 'M0 0 L10 5 L0 10z' })),
      s('marker', { id: 'arrHi', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, s('path', { class: 'arrow-shape hi', d: 'M0 0 L10 5 L0 10z' }))),
    columnEls, sequenceEls, edgeEls.flat(), nodeEls);

  const crumbs = lin ? h('div', { class: 'crumbs' }, h('span', { class: 'muted' }, 'Path to this call: '),
    lin.path.flatMap((id, i) => [
      i ? h('span', { class: 'muted' }, ' > ') : null,
      h('span', { class: `crumb${id === focus ? ' cur' : ''}`, onclick: () => focusOn(id) }, shortEndpoint(store.endpoints[byId.get(id).key])),
    ]),
    h('button', { onclick: () => { setMode('endpoints'); render(); } }, 'Open details')) : h('div', { class: 'crumbs muted' }, 'Click a call to see the path that leads to it and what it leads to.');
  const unlinked = graph.unlinked.length ? h('div', { class: 'unlinked' },
    h('div', { class: 'label' }, 'Not linked to other calls'),
    h('div', { class: 'chips' }, graph.unlinked.map((k) => h('span', { class: 'pill mono link', onclick: () => jumpTo(k) }, shortEndpoint(store.endpoints[k]))))) : null;

  right.replaceChildren(h('div', { class: 'detail' },
    h('div', { class: 'title' }, h('h2', {}, 'Graph'),
      h('div', { class: 'seg' }, [['values', 'By values'], ['steps', 'By steps']].map(([id, label]) => h('button', {
        class: mode === id ? 'active' : '', onclick: () => { state.graphMode = id; state.graphFocus = null; render(); },
      }, label))),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => { state.zoom = (state.zoom ?? zoom) / 1.25; render(); } }, '-'),
      h('button', { onclick: () => { state.zoom = (state.zoom ?? zoom) * 1.25; render(); } }, '+'),
      h('button', { onclick: () => { state.zoom = undefined; render(); } }, 'Fit')),
    h('div', { class: 'sub muted' }, mode === 'steps'
      ? 'Each column is a step and the blocks are the API calls made in it. A line means a value from one call is used in another; the dashed arrow shows the order of the steps. Analytics calls are left out.'
      : 'Each block is a call. A line means a value returned by one call is used in the next: the data starts on the left (for example the login) and leads to what you see on the right.'),
    crumbs,
    h('div', { class: 'graphwrap' }, svg),
    unlinked));
}

/** What a developer wants to know about an endpoint, read from its headers (authentication, paging, caching, CORS, ...). */
function headersBlock(ep) {
  const notes = devNotes(ep);
  const req = Object.keys(ep.reqHeaders ?? {});
  const res = Object.keys(ep.resHeaders ?? {});
  if (!notes.length && !req.length && !res.length) return null;
  const chips = (list) => h('div', { class: 'chips' },
    list.slice(0, 14).map((n) => h('span', { class: 'pill mono' }, n)),
    list.length > 14 ? h('span', { class: 'muted' }, `+${list.length - 14} more`) : null);
  const row = (label, content) => h('div', { class: 'hdrrow' }, h('span', { class: 'hdrlabel' }, label), content);
  return h('div', { class: 'hdrs' },
    h('div', { class: 'label' }, 'For developers, from the headers'),
    notes.map(([label, text]) => row(label, h('span', { class: 'mono' }, text))),
    req.length ? row('Request headers', chips(req)) : null,
    res.length ? row('Response headers', chips(res)) : null);
}

/** The operations inside one request (a batch or a GraphQL query with several fields), as chips. */
function subsBlock(ep) {
  const subs = Object.entries(ep.subs ?? {});
  if (!subs.length) return null;
  return h('div', { class: 'subs' }, h('span', { class: 'muted' }, 'Contains sub-calls: '),
    subs.map(([name, n]) => h('span', { class: 'pill mono', title: 'An operation inside the request' }, `${name} x${n}`)));
}

/** In the steps view: the operations inside a request, shown under it. */
const subRows = (c, depth) => (c.subs ?? []).map((name) => h('tr', { class: 'subrow' },
  h('td', {}), h('td', { colspan: 5 }, h('span', { class: 'nest', style: `margin-left:${depth * 20 + 20}px` }), h('span', { class: 'muted' }, 'inside this request: '), h('span', { class: 'mono' }, name))));

function fieldTable(node, term) {
  const t = term.trim().toLowerCase();
  const rows = flatten(node).filter((r) => !t || `${r.path} ${r.types.join(' ')} ${r.examples.join(' ')}`.toLowerCase().includes(t));
  const shown = rows.slice(0, MAX_ROWS);
  return h('div', { class: 'tablewrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Type'), h('th', {}, 'Present'), h('th', {}, 'Examples'))),
      h('tbody', {}, shown.map((r) => {
        const pct = Math.round(r.presence * 100);
        return h('tr', {},
          h('td', { class: 'field mono' }, highlight(r.path, t)),
          h('td', {}, r.types.map((ty) => h('span', { class: `pill t t-${ty}` }, ty)).flatMap((p) => [p, ' '])),
          h('td', {}, h('span', { class: `bar${pct < 100 ? ' partial' : ''}` }, h('i', { style: `width:${pct}%` })), `${pct}%`),
          h('td', { class: 'examples mono' }, highlight(r.examples.join(', '), t)));
      }))),
    rows.length > MAX_ROWS ? h('div', { class: 'empty' }, `Showing the first ${MAX_ROWS} of ${rows.length} fields. Narrow it down with the field filter.`) : null,
    !rows.length ? h('div', { class: 'empty' }, 'No fields match.') : null);
}

const card = (label, value, small = false) => h('div', { class: 'card' }, h('div', { class: 'label' }, label), h('div', { class: `value${small ? ' small' : ''}` }, String(value)));

const LABELS = { sample: 'Example', res: 'Response fields', req: 'Request fields' };

/** Pretty printed JSON with colours, built from DOM nodes (never innerHTML). */
function appendJson(parent, value, level = 0) {
  const pad = '  '.repeat(level);
  const span = (cls, text) => h('span', { class: cls }, text);
  if (value === null) parent.append(span('j-null', 'null'));
  else if (typeof value === 'number') parent.append(span('j-num', String(value)));
  else if (typeof value === 'boolean') parent.append(span('j-bool', String(value)));
  else if (typeof value === 'string') parent.append(span('j-str', JSON.stringify(value)));
  else if (Array.isArray(value)) {
    if (!value.length) { parent.append('[]'); return; }
    parent.append('[\n');
    value.forEach((v, i) => {
      parent.append(`${pad}  `);
      appendJson(parent, v, level + 1);
      parent.append(i < value.length - 1 ? ',\n' : '\n');
    });
    parent.append(`${pad}]`);
  } else {
    const entries = Object.entries(value);
    if (!entries.length) { parent.append('{}'); return; }
    parent.append('{\n');
    entries.forEach(([k, v], i) => {
      parent.append(`${pad}  `, span('j-key', JSON.stringify(k)), ': ');
      appendJson(parent, v, level + 1);
      parent.append(i < entries.length - 1 ? ',\n' : '\n');
    });
    parent.append(`${pad}}`);
  }
}

/** The real example calls of an endpoint: URL with query values, status, and what was sent and received. */
function sampleView(ep, eps) {
  const list = [...ep.samples].reverse(); // newest first
  const idx = Math.min(state.sample, list.length - 1);
  const s = list[idx];
  const block = (label, value) => {
    const pre = h('pre', { class: 'json mono' });
    appendJson(pre, value);
    const copy = h('button', {
      onclick: async (e) => {
        await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
        e.target.textContent = 'Copied';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
      },
    }, 'Copy');
    return h('div', {}, h('div', { class: 'label' }, label, copy), pre);
  };
  // Bodies that are not JSON (HTML, XML, plain text, scripts) are shown as they are.
  const textBlock = (label, text) => {
    const copy = h('button', {
      onclick: async (e) => {
        await navigator.clipboard.writeText(text);
        e.target.textContent = 'Copied';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
      },
    }, 'Copy');
    return h('div', {}, h('div', { class: 'label' }, label, copy), h('pre', { class: 'json mono wrap' }, text));
  };
  return h('div', { class: 'sample' },
    list.length > 1 ? h('div', { class: 'samplepick' }, list.map((_, i) => h('button', { class: i === idx ? 'active' : '', onclick: () => { state.sample = i; renderDetail(eps); } }, i === 0 ? 'Latest call' : `Call -${i}`))) : null,
    h('div', { class: 'callline' },
      h('span', { class: `mpill ${ep.method}` }, ep.method),
      h('span', { class: 'url mono' }, s.url),
      h('span', { class: `pill ${s.status >= 400 ? 'err' : 'ok'}` }, String(s.status)),
      h('span', { class: 'muted' }, `${s.timeMs} ms`),
      s.size ? h('span', { class: 'muted' }, formatBytes(s.size)) : null),
    s.req !== undefined ? block('Sent (request body)', s.req) : null,
    s.reqBinary ? h('div', { class: 'label' }, 'The request body is binary (for example compressed) and is not shown.') : null,
    s.reqText !== undefined ? textBlock(`Sent (request body, ${s.reqMime || 'text'})`, s.reqText) : null,
    s.res !== undefined ? block('Received (response body)', s.res) : null,
    s.resText !== undefined ? textBlock(`Received (response body, ${s.resMime || 'text'})`, s.resText) : null,
    s.res === undefined && s.resText === undefined
      ? h('div', { class: 'label' }, s.binary ? `The response is binary (${s.resMime || 'unknown type'}) and is not shown.`
        : s.skipped ? `The response body was not read: ${s.skipped}.` : 'This call had no response body.')
      : null,
    s.cut ? h('div', { class: 'label' }, 'Shortened for readability: first 3 items of lists, long texts cut.') : null);
}

function renderDetail(eps) {
  const right = $('right');
  const ep = store.endpoints[state.selected];
  if (!ep) {
    right.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, eps.length ? 'Select an endpoint' : 'Nothing to show'), eps.length ? 'Pick one on the left to see its fields.' : ''));
    return;
  }
  const sides = [ep.samples?.length ? 'sample' : null, ep.res ? 'res' : null, ep.req ? 'req' : null].filter(Boolean);
  const side = sides.includes(state.side) ? state.side : sides[0] ?? null;
  const slug = ep.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
  const copyMd = h('button', {
    onclick: async (e) => {
      await navigator.clipboard.writeText(toMarkdown(store, [ep.key]));
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy as Markdown'; }, 1200);
    },
  }, 'Copy as Markdown');

  right.replaceChildren(h('div', { class: 'detail' },
    h('div', { class: 'title' },
      h('span', { class: `mpill ${ep.method}` }, ep.method),
      h('h2', { class: 'mono' }, ep.path, ep.rpc ? h('span', { class: 'rpc' }, ` ${ep.rpc}`) : null),
      h('span', { class: 'spacer' }),
      copyMd,
      h('button', { onclick: () => download(`endpoint-${slug}.json`, JSON.stringify(ep, null, 2), 'application/json') }, 'Download JSON')),
    h('div', { class: 'sub muted' }, ep.host),
    h('div', { class: 'cards' },
      card('Calls', ep.count), card('Average', `${Math.round(avg(ep))} ms`), card('Slowest', `${Math.round(ep.timeMax)} ms`),
      ep.sizeCount ? card('Size (avg / max)', `${formatBytes(ep.sizeSum / ep.sizeCount)} / ${formatBytes(ep.sizeMax)}`, true) : null),
    // one row of chips: status codes, response content types, query parameter names
    h('div', { class: 'chips' },
      Object.entries(ep.statuses).map(([s, n]) => h('span', { class: `pill ${Number(s) >= 400 ? 'err' : 'ok'}` }, `${s} x${n}`)),
      Object.entries(ep.resTypes ?? {}).map(([k, n]) => h('span', { class: 'pill mono', title: 'Response content type' }, `${k} x${n}`)),
      Object.keys(ep.query).map((k) => h('span', { class: 'pill mono', title: 'Query parameter' }, `?${k}`))),
    headersBlock(ep),
    subsBlock(ep),
    flowBlock(ep),
    ep.samples?.length ? null : h('div', { class: 'hint muted' }, 'No example calls stored. Turn on "Keep example data" in the extension popup and record again.'),
    side ? h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', { class: 'seg' }, sides.map((s) => h('button', { class: side === s ? 'active' : '', onclick: () => { state.side = s; renderDetail(eps); } }, LABELS[s]))),
        side === 'sample' ? null : h('input', {
          type: 'search', placeholder: 'Filter fields', value: state.fieldQ,
          oninput: (e) => {
            state.fieldQ = e.target.value;
            const pos = e.target.selectionStart;
            renderDetail(eps);
            const box = right.querySelector('input[type=search]');
            box.focus();
            box.setSelectionRange(pos, pos);
          },
        })),
      side === 'sample' ? sampleView(ep, eps) : fieldTable(ep[side], state.fieldQ))
      : h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'No fields to show: the bodies of this endpoint are not JSON or form data. Tick "Keep example values and sample calls" and record again to see the text itself.'))));
}

function render() {
  const all = Object.values(store.endpoints);
  renderMulti('method', 'methods', countBy(all, (e) => e.method), state.methods);
  renderMulti('host', 'hosts', countBy(all, (e) => e.host), state.hosts);
  renderMulti('type', 'types', countBy(all, (e) => e.type || 'Unknown'), state.types);
  const eps = visible();
  if (!eps.some((e) => e.key === state.selected)) state.selected = eps[0]?.key ?? null; // always show something
  const calls = all.reduce((n, e) => n + e.count, 0);
  const errors = all.reduce((n, e) => n + errorCount(e), 0);
  // replaceChildren turns null into the text "null", so optional parts are filtered out first
  $('summary').replaceChildren(...[
    h('span', { class: 'stat' }, h('b', {}, all.filter(isApiType).length), ' API endpoints'),
    all.some((e) => !isApiType(e)) ? h('span', { class: 'stat muted' }, `${all.filter((e) => !isApiType(e)).length} scripts, styles and other files`) : null,
    h('span', { class: 'stat' }, h('b', {}, calls), ' calls'),
    errors > 0 ? h('span', { class: 'stat pill err' }, h('b', {}, errors), errors === 1 ? ' error' : ' errors') : null,
    store.steps?.length ? h('span', { class: 'stat' }, h('b', {}, store.steps.length), store.steps.length === 1 ? ' step' : ' steps') : null,
    store.started ? h('span', { class: 'stat muted' }, `since ${time(store.started)}`) : null,
  ].filter(Boolean));
  $('count').textContent = `${eps.length} of ${all.length}`;
  $('left').classList.toggle('steps-mode', state.mode === 'steps');
  if (state.mode === 'steps') { renderStepList(); renderStepDetail(); return; }
  if (state.mode === 'map') renderMap(eps); else renderList(eps);
  const right = $('right');
  const typingInDetail = right.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (state.mode === 'graph') { renderGraph(eps); return; }
  if (!typingInDetail) renderDetail(eps); // live updates must not steal focus from the field filter
}

function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

$('q').oninput = (e) => { state.q = e.target.value; render(); };
for (const b of document.querySelectorAll('#mode button')) b.onclick = () => { setMode(b.dataset.mode); render(); };
$('sort').onchange = (e) => { state.sort = e.target.value; render(); };
$('apiList').onchange = (e) => { state.apiList = e.target.checked; render(); };
$('errorsOnly').onchange = (e) => { state.errorsOnly = e.target.checked; render(); };
$('withBody').onchange = (e) => { state.withBody = e.target.checked; render(); };
$('exportMd').onclick = () => download(`endpoints-${stamp()}.md`, toMarkdown(store, visible().map((ep) => ep.key)), 'text/markdown');
$('exportJson').onclick = () => {
  const keep = new Set(visible().map((ep) => ep.key));
  const subset = { ...store, endpoints: Object.fromEntries(Object.entries(store.endpoints).filter(([k]) => keep.has(k))) };
  download(`endpoints-${stamp()}.json`, JSON.stringify(subset, null, 2), 'application/json');
};
$('clear').onclick = async () => {
  if (!confirm('Delete the whole recording? Export it first if you still need it.')) return;
  await chrome.runtime.sendMessage({ type: 'clear' }); // the background worker owns the recording and writes it
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.store) {
    store = changes.store.newValue ?? createStore();
    render();
  }
});

const saved = await chrome.storage.local.get('store');
store = saved.store ?? createStore();
render();
