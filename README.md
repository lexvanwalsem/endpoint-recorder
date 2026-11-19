# Endpoint Recorder

Chrome extension that records every XHR/fetch call of one browser tab and builds per endpoint the request and
response field structure (names, types, how often a field is present), call counts and timing.

## Install
1. Open `chrome://extensions`, switch on Developer mode.
2. Load unpacked, choose this folder (`C:\persoonlijk\endpoint-recorder`).
3. Pin the extension (puzzle icon, pin) so the icon stays visible.
After changing code: press the refresh icon on the extension card.

## Use
1. Open the web app in a tab, click the extension icon, press "Record this tab".
   Chrome shows a bar "Endpoint Recorder started debugging this browser": leave it open, closing it stops the recording.
2. Do the normal work in the system (open a ticket, reply to a mail, close a chat). No reload is needed; only calls made
   after you pressed the button are seen. "Reload tab" also catches the calls made while the page loads.
3. Click the icon again: a live list shows the endpoints with their call counts.
4. "Export Markdown" for reading, "Export JSON" for further processing. "Stop recording this tab" ends it, "Clear" empties
   the recording. Data lives in `chrome.storage.local` and is shared by all tabs you recorded.

## How it works
The extension attaches the Chrome debugger to the tab and listens to its Network events, the same source as the
DevTools Network tab. Per finished XHR/fetch call it asks for the response body. Nothing runs inside the page.
It works on tabs that were already open, follows navigation inside the tab, and sees calls from iframes.

## What is stored
- Method, host, path with ids replaced by `{id}`, query parameter names (no values), status codes, timing.
- JSON body structure. Example values only when "Keep example values" is ticked (they may hold customer data).
- Request headers are never looked at, so no cookies or tokens.
- JSON-RPC/GraphQL calls on one URL are split by `method` / `operationName` / Odoo `model.method`.

Limits: bodies over 5 MB are skipped, only JSON is analysed, arrays use the first 20 items, depth 8.
Not caught: WebSocket traffic, requests sent as FormData or binary. A tab that has DevTools open can usually still be
recorded; Chrome internal pages (`chrome://`) and the Web Store cannot be.
