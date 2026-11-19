import { addEntry, createStore, markStep } from './recorder.mjs';
import { addNav } from './flow.mjs';
import { createCapture } from './capture.mjs';

// The recording is kept in memory while the worker is awake and written to chrome.storage.local at most once per second.
// Writing the whole recording after every network event made busy pages (hundreds of events) block the worker, and with
// it the popup and the stop button. Messages from the popup never wait for those writes.
const SAVE_DELAY_MS = 1000;

let storePromise = null;
const getStore = () => (storePromise ??= chrome.storage.local.get('store').then(({ store }) => store ?? createStore()));

let saveTimer;
async function saveNow() {
  clearTimeout(saveTimer);
  if (storePromise) await chrome.storage.local.set({ store: await storePromise });
}
const scheduleSave = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, SAVE_DELAY_MS);
};
chrome.runtime.onSuspend.addListener(() => { saveNow().catch(() => {}); });

// The tabs being recorded live in memory too, and in chrome.storage.session so they survive a restart of the worker
// (the debugger attachment itself stays alive while the worker sleeps).
let tabsPromise = null;
const getTabs = () => (tabsPromise ??= chrome.storage.session.get('tabs').then(({ tabs }) => new Set(tabs ?? [])));
const persistTabs = async () => chrome.storage.session.set({ tabs: [...(await getTabs())] });

// Settings are cached because they are needed for every network event.
let settings = { keepExamples: true, analyseHeaders: true };
const settingsReady = chrome.storage.local.get('settings').then((saved) => { settings = { ...settings, ...saved.settings }; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settings = { keepExamples: true, analyseHeaders: true, ...changes.settings.newValue };
});

const capture = createCapture({
  getBody: (tabId, requestId) => chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId }),
  wantAll: () => true, // every request type, from every host the page talks to
  analyseHeaders: () => settings.analyseHeaders, // names, harmless values and token fingerprints, never secrets (headers.mjs)
  onEntry: async (entry) => {
    if (!/^https?:/.test(entry.url)) return;
    try {
      const store = await getStore();
      addEntry(store, entry, { keepExamples: settings.keepExamples });
      scheduleSave();
    } catch { /* one odd call must not stop the recording */ }
  },
});

// A page load or a route change inside a single page app starts a new step.
async function recordNav(url) {
  if (!/^https?:/.test(url)) return;
  addNav(await getStore(), { url });
  scheduleSave();
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  await settingsReady;
  if (source.tabId === undefined || !(await getTabs()).has(source.tabId)) return;
  if (method === 'Page.frameNavigated') {
    if (!params.frame.parentId) recordNav(params.frame.url); // main frame only, not iframes
    return;
  }
  if (method === 'Page.navigatedWithinDocument') {
    recordNav(params.url);
    return;
  }
  capture.handle(source.tabId, method, params);
});

// Forget a tab: used when the debugger detaches (bar closed, tab closed) and when the user presses stop.
async function forget(tabId) {
  capture.dropTab(tabId);
  (await getTabs()).delete(tabId);
  await persistTabs();
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  await saveNow().catch(() => {}); // what was recorded so far is safe
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) forget(source.tabId);
});

// Chrome clears a tab's badge on navigation: put it back.
chrome.tabs.onUpdated.addListener(async (tabId) => {
  if ((await getTabs()).has(tabId)) showBadge(tabId);
});

function showBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: 'REC' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#d92d20' }).catch(() => {});
}

async function start(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable'); // page and route changes, to detect steps
  (await getTabs()).add(tabId);
  await persistTabs();
  showBadge(tabId);
}

async function stop(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {}); // fails when already detached: that is fine
  await forget(tabId); // do not wait for the onDetach event, it may never come
}

async function handle(msg) {
  switch (msg.type) {
    case 'status': { // light: what the popup needs, not the whole recording
      await settingsReady;
      const store = await getStore();
      const eps = Object.values(store.endpoints);
      return {
        recording: (await getTabs()).has(msg.tabId),
        keepExamples: settings.keepExamples,
        analyseHeaders: settings.analyseHeaders,
        endpoints: eps.length,
        calls: eps.reduce((n, e) => n + e.count, 0),
        stepCount: store.steps?.length ?? 0,
        lastStep: store.steps?.at(-1)?.label ?? '',
      };
    }
    case 'get': // the whole recording, for export
      await settingsReady;
      return { store: await getStore(), recording: (await getTabs()).has(msg.tabId), keepExamples: settings.keepExamples };
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
    case 'mark': {
      const store = await getStore();
      const index = markStep(store, msg.label);
      scheduleSave();
      return { ok: true, index, label: store.steps[index].label };
    }
    case 'clear':
      storePromise = Promise.resolve(createStore());
      await saveNow();
      return null;
    case 'setSettings':
      await chrome.storage.local.set({ settings: { keepExamples: Boolean(msg.keepExamples), analyseHeaders: msg.analyseHeaders !== false } });
      return null;
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handle(msg).then(respond, (err) => respond({ ok: false, error: err.message }));
  return true;
});
