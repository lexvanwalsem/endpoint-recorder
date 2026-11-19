// Full page view of the recording: search, filter, sort, per-endpoint detail and export.
import { createStore, flatten, toMarkdown } from './recorder.mjs';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 1000;

let store = createStore();
const state = { q: '', method: '', host: '', sort: 'count', errorsOnly: false, withBody: false, selected: null, side: 'res', fieldQ: '' };

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
  const text = [ep.key, ...Object.keys(ep.query), ...rows.map((r) => `${r.path} ${r.examples.join(' ')}`)].join('\n').toLowerCase();
  indexCache.set(ep.key, { count: ep.count, text });
  return text;
}

const avg = (ep) => (ep.count ? ep.timeSum / ep.count : 0);
const hasError = (ep) => Object.keys(ep.statuses).some((s) => Number(s) >= 400);
const errorCount = (ep) => Object.entries(ep.statuses).filter(([s]) => Number(s) >= 400).reduce((n, [, c]) => n + c, 0);

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
  const max = Math.max(...eps.map((e) => e.count));
  list.replaceChildren(...eps.map((ep) => h('div', {
    class: `item${ep.key === state.selected ? ' selected' : ''}`,
    onclick: () => { state.selected = ep.key; state.fieldQ = ''; render(); },
  },
  h('div', { class: 'top' },
    h('span', { class: `mpill ${ep.method}` }, ep.method),
    h('span', { class: 'path mono' }, highlight(ep.path, state.q.trim()), ep.rpc ? h('span', { class: 'rpc' }, ` ${ep.rpc}`) : null)),
  h('div', { class: 'host' }, ep.host),
  h('div', { class: 'stats' },
    h('b', {}, ep.count), h('span', { class: 'muted' }, ep.count === 1 ? ' call' : ' calls'),
    h('div', { class: 'meter' }, h('i', { style: `width:${Math.max(6, Math.round((ep.count / max) * 100))}%` })),
    h('span', { class: 'muted' }, `${Math.round(avg(ep))} ms`),
    hasError(ep) ? h('div', {}, h('span', { class: 'pill err' }, plural(errorCount(ep), 'error'))) : null))));
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

function renderDetail(eps) {
  const right = $('right');
  const ep = store.endpoints[state.selected];
  if (!ep) {
    right.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, eps.length ? 'Select an endpoint' : 'Nothing to show'), eps.length ? 'Pick one on the left to see its fields.' : ''));
    return;
  }
  const side = state.side === 'req' && ep.req ? 'req' : ep.res ? 'res' : ep.req ? 'req' : null;
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
      h('h2', { class: 'mono' }, ep.path, ep.rpc ? h('span', { class: 'rpc' }, ` ${ep.rpc}`) : null)),
    h('div', { class: 'sub muted' }, ep.host),
    h('div', { class: 'cards' },
      card('Calls', ep.count), card('Average', `${Math.round(avg(ep))} ms`), card('Slowest', `${Math.round(ep.timeMax)} ms`),
      card('First seen', time(ep.firstSeen), true), card('Last seen', time(ep.lastSeen), true)),
    h('div', { class: 'block' }, h('div', { class: 'label' }, 'Status codes'),
      h('div', { class: 'chips' }, Object.entries(ep.statuses).map(([s, n]) => h('span', { class: `pill ${Number(s) >= 400 ? 'err' : 'ok'}` }, `${s}  x${n}`)))),
    Object.keys(ep.query).length ? h('div', { class: 'block' }, h('div', { class: 'label' }, 'Query parameters (names only)'),
      h('div', { class: 'chips' }, Object.entries(ep.query).map(([k, n]) => h('span', { class: 'pill mono' }, `${k} (${n})`)))) : null,
    h('div', { class: 'tools' }, copyMd,
      h('button', { onclick: () => download(`endpoint-${slug}.json`, JSON.stringify(ep, null, 2), 'application/json') }, 'Download JSON')),
    side ? h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', { class: 'seg' },
          ep.req ? h('button', { class: side === 'req' ? 'active' : '', onclick: () => { state.side = 'req'; renderDetail(eps); } }, 'Request body') : null,
          ep.res ? h('button', { class: side === 'res' ? 'active' : '', onclick: () => { state.side = 'res'; renderDetail(eps); } }, 'Response body') : null),
        h('input', {
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
      fieldTable(ep[side], state.fieldQ))
      : h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'No JSON body was captured for this endpoint.'))));
}

function render() {
  const all = Object.values(store.endpoints);
  state.method = fillSelect($('method'), [...new Set(all.map((e) => e.method))].sort(), 'All methods');
  state.host = fillSelect($('host'), [...new Set(all.map((e) => e.host))].sort(), 'All hosts');
  const eps = visible();
  if (!eps.some((e) => e.key === state.selected)) state.selected = eps[0]?.key ?? null; // always show something
  const calls = all.reduce((n, e) => n + e.count, 0);
  const errors = all.reduce((n, e) => n + errorCount(e), 0);
  $('summary').replaceChildren(
    h('span', { class: 'stat' }, h('b', {}, all.length), ' endpoints'),
    h('span', { class: 'stat' }, h('b', {}, calls), ' calls'),
    errors ? h('span', { class: 'stat pill err' }, h('b', {}, errors), ' errors') : null,
    store.started ? h('span', { class: 'stat muted' }, `since ${time(store.started)}`) : null);
  $('count').textContent = `${eps.length} of ${all.length}`;
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
