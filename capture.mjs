// Turns Chrome DevTools Protocol Network events into finished-call entries. No chrome.* APIs here, so it can be unit tested.
// Of the request headers only Content-Type is read (to know how to parse a body). Cookies and tokens are never looked at.

// Bodies of any size are read up to this cap; beyond it the call is kept without its body.
export const MAX_BODY = 50_000_000;

const API_TYPES = new Set(['XHR', 'Fetch']);
// Resource types whose body is worth reading. Scripts, styles, images, fonts and media only get mime type and size.
const BODY_TYPES = new Set(['XHR', 'Fetch', 'Document', 'Other']);
const READABLE = /json|text|xml|html|javascript|csv|yaml|x-www-form-urlencoded|graphql|^$/i;

/**
 * getBody(tabId, requestId) -> Promise<{ body, base64Encoded }>
 * onEntry({ method, url, status, timeMs, type, size, reqText, reqMime, resText, resMime, binary, skipped })
 * wantAll(): when true every request type is recorded, otherwise only XHR and fetch calls.
 */
export function createCapture({ getBody, onEntry, wantAll = () => false }) {
  const pending = new Map();
  const MAX_PENDING = 5000;

  async function handle(tabId, method, p) {
    const key = `${tabId}:${p.requestId}`;
    switch (method) {
      case 'Network.requestWillBeSent': {
        if (!API_TYPES.has(p.type) && !wantAll()) { pending.delete(key); return; }
        if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
        const contentType = Object.entries(p.request.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
        pending.set(key, { method: p.request.method, url: p.request.url, type: p.type, reqText: p.request.postData, reqMime: contentType, start: p.timestamp });
        return;
      }
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
        const size = p.encodedDataLength;
        let resText;
        let binary = false;
        let skipped;
        if (BODY_TYPES.has(r.type)) {
          if (size > MAX_BODY) {
            skipped = 'too large';
          } else if (READABLE.test(r.resMime ?? '')) {
            try {
              const b = await getBody(tabId, p.requestId);
              if (b.base64Encoded) binary = true;
              else resText = b.body;
            } catch { skipped = 'not available'; } // body gone (redirect, cache): keep the call without it
          } else {
            binary = true;
          }
        }
        onEntry({
          method: r.method, url: r.url, status: r.status ?? 0, timeMs: (p.timestamp - r.start) * 1000, type: r.type, size,
          reqText: r.reqText, reqMime: r.reqMime, resText, resMime: r.resMime, binary, skipped,
        });
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
