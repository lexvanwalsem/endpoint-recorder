import { toMarkdown } from './recorder.mjs';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = '';
try { host = new URL(tab.url).host; } catch { /* no usable tab */ }
$('site').textContent = host || tab?.title || 'unknown tab';

async function render() {
  const { store, recording, keepExamples, allTypes } = await send({ type: 'get', tabId: tab.id });
  const eps = Object.values(store.endpoints).sort((a, b) => b.count - a.count);
  $('toggle').textContent = recording ? 'Stop recording this tab' : 'Record this tab';
  $('toggle').classList.toggle('primary', !recording);
  if (document.activeElement !== $('examples')) $('examples').checked = keepExamples;
  if (document.activeElement !== $('allTypes')) $('allTypes').checked = allTypes;

  const calls = eps.reduce((s, e) => s + e.count, 0);
  const line = document.createElement('div');
  line.className = 'big';
  if (recording) {
    const dot = document.createElement('span');
    dot.className = 'rec-dot';
    line.append(dot);
  }
  line.append(`${recording ? 'Recording' : 'Not recording'}`);
  const detail = document.createElement('div');
  detail.className = 'muted';
  detail.textContent = `${eps.length} endpoints, ${calls} calls in the recording`;
  $('state').className = `status${recording ? ' on' : ''}`;
  $('state').replaceChildren(line, detail);

  $('list').replaceChildren(...eps.slice(0, 8).map((ep) => {
    const row = document.createElement('div');
    const n = Object.assign(document.createElement('span'), { className: 'n', textContent: ep.count });
    const u = Object.assign(document.createElement('span'), { className: 'u mono', textContent: `${ep.method} ${ep.path}${ep.rpc ? ` [${ep.rpc}]` : ''}` });
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
const saveSettings = () => send({ type: 'setSettings', keepExamples: $('examples').checked, allTypes: $('allTypes').checked });
$('examples').onchange = saveSettings;
$('allTypes').onchange = saveSettings;

$('open').onclick = async () => {
  const url = chrome.runtime.getURL('viewer.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
};

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
