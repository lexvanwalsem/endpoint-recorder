// Full page view of the recording: search, filter, sort, per-endpoint detail and export.
import { createStore, endpointLabel, flatten, formatBytes, groupSteps, isApiCall, toMarkdown } from './recorder.mjs';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 1000;

let store = createStore();
const state = { q: '', method: '', host: '', type: '', sort: 'count', errorsOnly: false, withBody: false, selected: null, side: 'sample', sample: 0, fieldQ: '', mode: 'endpoints', step: undefined, apiOnly: true };

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
    .filter((ep) => (!state.method || ep.method === state.method)
      && (!state.host || ep.host === state.host)
      && (!state.type || (ep.type || 'Unknown') === state.type)
      && (!state.errorsOnly || hasError(ep))
      && (!state.withBody || ep.req || ep.res)
      && (!q || searchText(ep).includes(q)))
    .sort(sorters[state.sort]);
}

function fillSelect(select, values, label) {
  const current = select.value;
  select.replaceChildren(h('option', { value: '' }, label), ...values.map((v) => h('option', { value: v }, v)));
  select.value = values.includes(current) ? current : '';
  return select.value;
}

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
  setMode('endpoints');
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

function renderStepList() {
  const groups = groupSteps(store);
  const list = $('list');
  if (!groups.length) {
    list.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'big' }, 'No steps yet'),
      'While recording, type what you are about to do in the extension popup and press "Mark step". Calls are then grouped per step.'));
    return;
  }
  if (!groups.some((g) => g.index === state.step)) state.step = groups[groups.length - 1].index; // newest step
  list.replaceChildren(...groups.map((g) => h('div', {
    class: `item${g.index === state.step ? ' selected' : ''}`,
    onclick: () => { state.step = g.index; render(); },
  },
  h('div', { class: 'top' }, h('span', { class: 'path' }, g.index === null ? g.label : `${g.index + 1}. ${g.label}`)),
  h('div', { class: 'meta' }, `${plural(g.calls.filter(isApiCall).length, 'API call')}${g.at ? ` · ${new Date(g.at).toLocaleTimeString()}` : ''}`))));
}

function renderStepDetail() {
  const right = $('right');
  const g = groupSteps(store).find((x) => x.index === state.step);
  if (!g) { right.replaceChildren(h('div', { class: 'empty' })); return; }
  const calls = g.calls.filter((c) => (!state.apiOnly || isApiCall(c)) && store.endpoints[c.key]);
  const t0 = g.at ? Date.parse(g.at) : (g.calls[0]?.at ?? 0);
  right.replaceChildren(h('div', { class: 'detail' },
    h('div', { class: 'title' }, h('h2', {}, g.index === null ? g.label : `Step ${g.index + 1}: ${g.label}`)),
    h('div', { class: 'sub muted' }, `${g.at ? `${time(g.at)} · ` : ''}${plural(calls.length, 'call')} shown`),
    h('div', { class: 'tools' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.apiOnly, onchange: (e) => { state.apiOnly = e.target.checked; render(); } }), ' API calls only (XHR and fetch)')),
    h('div', { class: 'panel' }, h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Time', 'Call', 'Status', 'Duration', 'Size', 'Type'].map((t) => h('th', {}, t)))),
      h('tbody', {}, calls.map((c) => {
        const ep = store.endpoints[c.key];
        return h('tr', {},
          h('td', { class: 'mono' }, `+${Math.max(0, (c.at - t0) / 1000).toFixed(1)} s`),
          h('td', {}, h('span', { class: `mpill ${ep.method}` }, ep.method), ' ', h('span', { class: 'link mono', onclick: () => jumpTo(c.key) }, ep.path + (ep.rpc ? ` ${ep.rpc}` : '')), h('div', { class: 'muted' }, ep.host)),
          h('td', {}, h('span', { class: `pill ${c.status >= 400 ? 'err' : 'ok'}` }, String(c.status))),
          h('td', {}, `${c.timeMs} ms`),
          h('td', {}, c.size ? formatBytes(c.size) : '-'),
          h('td', {}, c.type || '-'));
      })))))));
}


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
  state.method = fillSelect($('method'), [...new Set(all.map((e) => e.method))].sort(), 'All methods');
  state.host = fillSelect($('host'), [...new Set(all.map((e) => e.host))].sort(), 'All hosts');
  state.type = fillSelect($('type'), [...new Set(all.map((e) => e.type || 'Unknown'))].sort(), 'All types');
  const eps = visible();
  if (!eps.some((e) => e.key === state.selected)) state.selected = eps[0]?.key ?? null; // always show something
  const calls = all.reduce((n, e) => n + e.count, 0);
  const errors = all.reduce((n, e) => n + errorCount(e), 0);
  // replaceChildren turns null into the text "null", so optional parts are filtered out first
  $('summary').replaceChildren(...[
    h('span', { class: 'stat' }, h('b', {}, all.length), ' endpoints'),
    h('span', { class: 'stat' }, h('b', {}, calls), ' calls'),
    errors > 0 ? h('span', { class: 'stat pill err' }, h('b', {}, errors), errors === 1 ? ' error' : ' errors') : null,
    store.steps?.length ? h('span', { class: 'stat' }, h('b', {}, store.steps.length), store.steps.length === 1 ? ' step' : ' steps') : null,
    store.started ? h('span', { class: 'stat muted' }, `since ${time(store.started)}`) : null,
  ].filter(Boolean));
  $('count').textContent = `${eps.length} of ${all.length}`;
  $('left').classList.toggle('steps-mode', state.mode === 'steps');
  if (state.mode === 'steps') { renderStepList(); renderStepDetail(); return; }
  renderList(eps);
  const right = $('right');
  const typingInDetail = right.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (!typingInDetail) renderDetail(eps); // live updates must not steal focus from the field filter
}

function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

$('q').oninput = (e) => { state.q = e.target.value; render(); };
$('method').onchange = (e) => { state.method = e.target.value; render(); };
$('host').onchange = (e) => { state.host = e.target.value; render(); };
for (const b of document.querySelectorAll('#mode button')) b.onclick = () => { setMode(b.dataset.mode); render(); };
$('type').onchange = (e) => { state.type = e.target.value; render(); };
$('sort').onchange = (e) => { state.sort = e.target.value; render(); };
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
  await chrome.storage.local.set({ store: createStore() });
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
