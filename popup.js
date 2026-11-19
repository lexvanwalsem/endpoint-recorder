import { toMarkdown } from './recorder.mjs';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = '';
try { host = new URL(tab.url).host; } catch { /* no usable tab */ }
$('site').textContent = host || tab?.title || 'unknown tab';

async function render() {
  const { store, recording, keepExamples } = await send({ type: 'get', tabId: tab.id });
  const eps = Object.values(store.endpoints);
  const calls = eps.reduce((s, e) => s + e.count, 0);
  $('toggle').textContent = recording ? 'Stop recording' : 'Record this tab';
  $('toggle').classList.toggle('primary', !recording);
  if (document.activeElement !== $('examples')) $('examples').checked = keepExamples;

  const line = document.createDocumentFragment();
  if (recording) line.append(Object.assign(document.createElement('span'), { className: 'rec-dot' }));
  line.append(`${recording ? 'Recording' : 'Not recording'}: ${eps.length} endpoints, ${calls} calls`);
  $('state').className = `status${recording ? ' on' : ''}`;
  $('state').replaceChildren(line);

  // marking steps only makes sense while recording
  $('stepBox').hidden = !recording;
  const steps = store.steps ?? [];
  $('stepNow').textContent = steps.length ? `Current step ${steps.length}: ${steps.at(-1).label}` : 'Steps are detected automatically. Mark one yourself to give it your own name.';
  return recording;
}

$('toggle').onclick = async () => {
  const recording = await render();
  const result = await send({ type: recording ? 'stop' : 'start', tabId: tab.id });
  $('error').textContent = result?.ok === false ? `Could not start: ${result.error}` : '';
  await render();
};

async function markCurrentStep() {
  const label = $('stepLabel').value;
  await send({ type: 'mark', label });
  $('stepLabel').value = '';
  await render();
}
$('mark').onclick = markCurrentStep;
$('stepLabel').onkeydown = (e) => { if (e.key === 'Enter') markCurrentStep(); };

$('reload').onclick = () => chrome.tabs.reload(tab.id);
$('examples').onchange = () => send({ type: 'setSettings', keepExamples: $('examples').checked });

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
