// Turns Chrome DevTools Protocol Network events into finished-call entries. No chrome.* APIs here, so it can be unit tested.
// Headers are only summarised (names, a few harmless values, a fingerprint of tokens): see headers.mjs. Raw header values
// are dropped as soon as the call is finished and never end up in an entry.
import { summarizeHeaders } from './headers.mjs';

// Bodies of any size are read up to this cap; beyond it the call is kept without its body.
export const MAX_BODY = 50_000_000;

const API_TYPES = new Set(['XHR', 'Fetch']);
// Resource types whose body is worth reading. Scripts, styles, images, fonts and media only get mime type and size.
const BODY_TYPES = new Set(['XHR', 'Fetch', 'Document', 'Other']);
const READABLE = /json|text|xml|html|javascript|csv|yaml|x-www-form-urlencoded|graphql|^$/i;

/**
 * getBody(tabId, requestId) -> Promise<{ body, base64Encoded }>
 * onEntry({ method, url, status, timeMs, type, size, reqText, reqMime, resText, resMime, binary, skipped, headers })
 * wantAll(): when true every request type is recorded, otherwise only XHR and fetch calls.
 * analyseHeaders(): when true the headers of each call are summarised into entry.headers.
 */
export function createCapture({ getBody, onEntry, wantAll = () => false, analyseHeaders = () => false }) {
  const pending = new Map();
  const early = new Map(); // extra info that arrived before the request itself
  const MAX_PENDING = 5000;

  const merge = (r, extra) => {
    Object.assign(r.reqHeaders, extra.reqHeaders ?? {});
    if (extra.setCookie) r.setCookie = extra.setCookie;
  };

  async function handle(tabId, method, p) {
    const key = `${tabId}:${p.requestId}`;
    switch (method) {
      case 'Network.requestWillBeSent': {
        if (!API_TYPES.has(p.type) && !wantAll()) { pending.delete(key); return; }
        if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
        const contentType = Object.entries(p.request.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
        const r = {
          method: p.request.method, url: p.request.url, type: p.type, reqText: p.request.postData, reqMime: contentType, start: p.timestamp,
          reqHeaders: { ...(p.request.headers ?? {}) }, resHeaders: {},
        };
        pending.set(key, r);
        if (early.has(key)) { merge(r, early.get(key)); early.delete(key); }
        return;
      }
      case 'Network.requestWillBeSentExtraInfo': { // the cookies of the request are only reported here
        const r = pending.get(key);
        if (r) merge(r, { reqHeaders: p.headers });
        else if (early.size < 200) early.set(key, { reqHeaders: p.headers });
        return;
      }
      case 'Network.responseReceived': {
        const r = pending.get(key);
        if (r) Object.assign(r, { status: p.response.status, resMime: p.response.mimeType, resHeaders: p.response.headers ?? {} });
        return;
      }
      case 'Network.responseReceivedExtraInfo': { // Set-Cookie is only reported here
        const r = pending.get(key);
        if (r && p.headers) {
          const line = Object.entries(p.headers).find(([k]) => k.toLowerCase() === 'set-cookie')?.[1];
          if (line) r.setCookie = line;
        }
        return;
      }
      case 'Network.loadingFailed':
        pending.delete(key);
        early.delete(key);
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
        let headers;
        if (analyseHeaders()) {
          try { headers = await summarizeHeaders({ req: r.reqHeaders, res: r.resHeaders, setCookie: r.setCookie }); } catch { headers = undefined; }
        }
        onEntry({
          method: r.method, url: r.url, status: r.status ?? 0, timeMs: (p.timestamp - r.start) * 1000, type: r.type, size,
          reqText: r.reqText, reqMime: r.reqMime, resText, resMime: r.resMime, binary, skipped, headers,
        });
        return;
      }
      default:
    }
  }

  function dropTab(tabId) {
    for (const key of pending.keys()) if (key.startsWith(`${tabId}:`)) pending.delete(key);
    for (const key of early.keys()) if (key.startsWith(`${tabId}:`)) early.delete(key);
  }

  return { handle, dropTab };
}
