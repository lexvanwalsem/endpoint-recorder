import { toMarkdown } from './recorder.mjs';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = '';
try { host = new URL(tab.url).host; } catch { /* no usable tab */ }
$('site').textContent = `Tab: ${host || tab?.title || 'unknown'}`;

async function render() {
  const { store, recording, keepExamples } = await send({ type: 'get', tabId: tab.id });
  const eps = Object.values(store.endpoints).sort((a, b) => b.count - a.count);
  $('toggle').textContent = recording ? 'Stop recording this tab' : 'Record this tab';
  $('examples').checked = keepExamples;
  const line = document.createElement('div');
  line.className = recording ? 'rec' : 'muted';
  line.textContent = `${recording ? 'Recording' : 'Not recording'}: ${eps.length} endpoints, ${eps.reduce((s, e) => s + e.count, 0)} calls`;
  $('state').replaceChildren(line);
  $('list').replaceChildren(...eps.slice(0, 60).map((ep) => {
    const row = document.createElement('div');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = ep.count;
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = `${ep.method} ${ep.host}${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}`;
    row.append(n, u);
    return row;
  }));
  return recording;
}

$('toggle').onclick = async () => {
  const recording = await render();
  const result = await send({ type: recording ? 'stop' : 'start', tabId: tab.id });
  $('error').textContent = result?.ok === false ? `Could not start: ${result.error}` : '';
  await render();
};

$('reload').onclick = () => chrome.tabs.reload(tab.id);
$('examples').onchange = () => send({ type: 'setExamples', value: $('examples').checked });

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

$('md').onclick = async () => download(`endpoints-${stamp()}.md`, toMarkdown((await send({ type: 'get', tabId: tab.id })).store), 'text/markdown');
$('json').onclick = async () => download(`endpoints-${stamp()}.json`, JSON.stringify((await send({ type: 'get', tabId: tab.id })).store, null, 2), 'application/json');
$('clear').onclick = async () => { await send({ type: 'clear' }); await render(); };

await render();
setInterval(render, 1000); // live view while the popup is open
