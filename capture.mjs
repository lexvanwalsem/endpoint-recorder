// Turns Chrome DevTools Protocol Network events into finished-call entries. No chrome.* APIs here, so it can be unit tested.
// Request headers are never looked at, so cookies and tokens cannot end up in a recording.

const MAX_BODY = 5_000_000;
const MAX_PENDING = 2000;
const TYPES = new Set(['XHR', 'Fetch']);
const READABLE = /json|text|graphql|javascript|^$/i;

/**
 * getBody(tabId, requestId) -> Promise<{ body, base64Encoded }>
 * onEntry({ method, url, status, timeMs, reqText, resText, resMime })
 */
export function createCapture({ getBody, onEntry }) {
  const pending = new Map();

  async function handle(tabId, method, p) {
    const key = `${tabId}:${p.requestId}`;
    switch (method) {
      case 'Network.requestWillBeSent':
        if (!TYPES.has(p.type)) return;
        if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
        pending.set(key, { method: p.request.method, url: p.request.url, reqText: p.request.postData, start: p.timestamp });
        return;
      case 'Network.responseReceived': {
        const r = pending.get(key);
        if (r) Object.assign(r, { status: p.response.status, resMime: p.response.mimeType });
        return;
      }
      case 'Network.loadingFailed':
        pending.delete(key);
        return;
      case 'Network.loadingFinished': {
        const r = pending.get(key);
        if (!r) return;
        pending.delete(key);
        let resText;
        if (p.encodedDataLength <= MAX_BODY && READABLE.test(r.resMime ?? '')) {
          try {
            const b = await getBody(tabId, p.requestId);
            if (!b.base64Encoded) resText = b.body;
          } catch { /* body gone (redirect, cache): keep the call without it */ }
        }
        onEntry({ method: r.method, url: r.url, status: r.status ?? 0, timeMs: (p.timestamp - r.start) * 1000, reqText: r.reqText, resText, resMime: r.resMime });
        return;
      }
      default:
    }
  }

  function dropTab(tabId) {
    for (const key of pending.keys()) if (key.startsWith(`${tabId}:`)) pending.delete(key);
  }

  return { handle, dropTab };
}
