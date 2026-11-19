import { toMarkdown } from './recorder.mjs';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = '';
try { host = new URL(tab.url).host; } catch { /* no usable tab */ }
$('site').textContent = host || tab?.title || 'unknown tab';

let isRecording = false;

// Asks only for a light status (counts and the last step), never for the whole recording.
async function render() {
  let s;
  try {
    s = await send({ type: 'status', tabId: tab.id });
  } catch {
    s = null;
  }
  if (!s) {
    $('error').textContent = 'Surveyor does not answer. Reload the extension in chrome://extensions.';
    return;
  }
  isRecording = s.recording;
  $('toggle').textContent = s.recording ? 'Stop recording' : 'Record this tab';
  $('toggle').classList.toggle('primary', !s.recording);
  if (document.activeElement !== $('examples')) $('examples').checked = s.keepExamples;
  if (document.activeElement !== $('headers')) $('headers').checked = s.analyseHeaders;

  const line = document.createDocumentFragment();
  if (s.recording) line.append(Object.assign(document.createElement('span'), { className: 'rec-dot' }));
  line.append(`${s.recording ? 'Recording' : 'Not recording'}: ${s.endpoints} endpoints, ${s.calls} calls`);
  $('state').className = `status${s.recording ? ' on' : ''}`;
  $('state').replaceChildren(line);

  // marking steps only makes sense while recording
  $('stepBox').hidden = !s.recording;
  $('stepNow').textContent = s.stepCount ? `Current step ${s.stepCount}: ${s.lastStep}` : 'Steps are detected automatically. Mark one yourself to give it your own name.';
}

// Start and stop do not wait for a status first, so stopping always works.
$('toggle').onclick = async () => {
  const wasRecording = isRecording;
  $('toggle').disabled = true;
  try {
    const result = await send({ type: wasRecording ? 'stop' : 'start', tabId: tab.id });
    $('error').textContent = result?.ok === false ? `Could not ${wasRecording ? 'stop' : 'start'}: ${result.error}` : '';
  } finally {
    $('toggle').disabled = false;
  }
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
const saveSettings = () => send({ type: 'setSettings', keepExamples: $('examples').checked, analyseHeaders: $('headers').checked });
$('examples').onchange = saveSettings;
$('headers').onchange = saveSettings;

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
