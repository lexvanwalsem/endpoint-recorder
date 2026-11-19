import { addEntry, createStore } from './recorder.mjs';
import { createCapture } from './capture.mjs';

// The worker can be stopped at any time. The recording lives in chrome.storage.local, the list of tabs being
// recorded in chrome.storage.session (the debugger attachment itself stays alive while the worker sleeps).
let queue = Promise.resolve();
function enqueue(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

const recordingTabs = async () => (await chrome.storage.session.get('tabs')).tabs ?? [];
const setRecordingTabs = (tabs) => chrome.storage.session.set({ tabs });

// Settings are cached because they are needed for every network event.
let settings = { keepExamples: false, allTypes: false };
const settingsReady = chrome.storage.local.get('settings').then((saved) => { settings = { ...settings, ...saved.settings }; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settings = { keepExamples: false, allTypes: false, ...changes.settings.newValue };
});

async function load() {
  await settingsReady;
  const { store } = await chrome.storage.local.get('store');
  return { store: store ?? createStore(), keepExamples: settings.keepExamples, allTypes: settings.allTypes };
}

const capture = createCapture({
  getBody: (tabId, requestId) => chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId }),
  wantAll: () => settings.allTypes,
  onEntry: (entry) => enqueue(async () => {
    if (!/^https?:/.test(entry.url)) return;
    const { store, keepExamples } = await load();
    addEntry(store, entry, { keepExamples });
    await chrome.storage.local.set({ store });
  }),
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  await settingsReady;
  if (source.tabId !== undefined && (await recordingTabs()).includes(source.tabId)) capture.handle(source.tabId, method, params);
});

// Forget a tab: used when the debugger detaches (bar closed, tab closed) and when the user presses stop.
async function forget(tabId) {
  capture.dropTab(tabId);
  await setRecordingTabs((await recordingTabs()).filter((id) => id !== tabId));
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) forget(source.tabId);
});

// Chrome clears a tab's badge on navigation: put it back.
chrome.tabs.onUpdated.addListener(async (tabId) => {
  if ((await recordingTabs()).includes(tabId)) showBadge(tabId);
});

function showBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: 'REC' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#d92d20' }).catch(() => {});
}

async function start(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  await setRecordingTabs([...new Set([...(await recordingTabs()), tabId])]);
  showBadge(tabId);
}

async function stop(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {}); // fails when already detached: that is fine
  await forget(tabId); // do not wait for the onDetach event, it may never come
}

async function handle(msg) {
  switch (msg.type) {
    case 'get':
      return { ...(await load()), recording: (await recordingTabs()).includes(msg.tabId) };
    case 'start':
      try {
        await start(msg.tabId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    case 'stop':
      await stop(msg.tabId);
      return { ok: true };
    case 'clear':
      await chrome.storage.local.set({ store: createStore() });
      return null;
    case 'setSettings':
      await chrome.storage.local.set({ settings: { keepExamples: Boolean(msg.keepExamples), allTypes: Boolean(msg.allTypes) } });
      return null;
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  enqueue(() => handle(msg)).then(respond, (err) => respond({ ok: false, error: err.message }));
  return true;
});
