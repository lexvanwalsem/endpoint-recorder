// Full page view of the recording: search, filter, sort, per-endpoint detail and export.
import { createStore, flatten, formatBytes, toMarkdown } from './recorder.mjs';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 1000;

let store = createStore();
const state = { q: '', method: '', host: '', type: '', sort: 'count', errorsOnly: false, withBody: false, selected: null, side: 'sample', sample: 0, fieldQ: '' };

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
  const text = [ep.key, ...Object.keys(ep.query), ...rows.map((r) => `${r.path} ${r.examples.join(' ')}`), ...samples].join('\n').toLowerCase();
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
  const max = Math.max(...eps.map((e) => e.count));
  list.replaceChildren(...eps.map((ep) => h('div', {
    class: `item${ep.key === state.selected ? ' selected' : ''}`,
    onclick: () => { state.selected = ep.key; state.fieldQ = ''; state.sample = 0; render(); },
  },
  h('div', { class: 'top' },
    h('span', { class: `mpill ${ep.method}` }, ep.method),
    h('span', { class: 'path mono' }, highlight(ep.path, state.q.trim()), ep.rpc ? h('span', { class: 'rpc' }, ` ${ep.rpc}`) : null),
    ep.type && !['XHR', 'Fetch'].includes(ep.type) ? h('span', { class: 'pill' }, ep.type) : null),
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
      h('h2', { class: 'mono' }, ep.path, ep.rpc ? h('span', { class: 'rpc' }, ` ${ep.rpc}`) : null)),
    h('div', { class: 'sub muted' }, ep.host),
    h('div', { class: 'cards' },
      card('Calls', ep.count), card('Average', `${Math.round(avg(ep))} ms`), card('Slowest', `${Math.round(ep.timeMax)} ms`),
      ep.sizeCount ? card('Size (avg / max)', `${formatBytes(ep.sizeSum / ep.sizeCount)} / ${formatBytes(ep.sizeMax)}`, true) : null,
      card('First seen', time(ep.firstSeen), true), card('Last seen', time(ep.lastSeen), true)),
    h('div', { class: 'block' }, h('div', { class: 'label' }, 'Status codes'),
      h('div', { class: 'chips' }, Object.entries(ep.statuses).map(([s, n]) => h('span', { class: `pill ${Number(s) >= 400 ? 'err' : 'ok'}` }, `${s}  x${n}`)))),
    Object.keys(ep.reqTypes ?? {}).length ? h('div', { class: 'block' }, h('div', { class: 'label' }, 'Request content types'),
      h('div', { class: 'chips' }, Object.entries(ep.reqTypes).map(([k, n]) => h('span', { class: 'pill mono' }, `${k} x${n}`)))) : null,
    Object.keys(ep.resTypes ?? {}).length ? h('div', { class: 'block' }, h('div', { class: 'label' }, 'Response content types'),
      h('div', { class: 'chips' }, Object.entries(ep.resTypes).map(([k, n]) => h('span', { class: 'pill mono' }, `${k} x${n}`)))) : null,
    Object.keys(ep.query).length ? h('div', { class: 'block' }, h('div', { class: 'label' }, 'Query parameters (names only)'),
      h('div', { class: 'chips' }, Object.entries(ep.query).map(([k, n]) => h('span', { class: 'pill mono' }, `${k} (${n})`)))) : null,
    h('div', { class: 'tools' }, copyMd,
      h('button', { onclick: () => download(`endpoint-${slug}.json`, JSON.stringify(ep, null, 2), 'application/json') }, 'Download JSON')),
    ep.samples?.length ? null : h('div', { class: 'note' }, 'No example calls were stored for this endpoint. Tick "Keep example values" in the extension popup and record again to see real requests and responses here.'),
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
    store.started ? h('span', { class: 'stat muted' }, `since ${time(store.started)}`) : null,
  ].filter(Boolean));
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
