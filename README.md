<p align="center">
  <img src="icons/icon-128.png" alt="Endpoint Recorder logo" width="96" height="96">
</p>

<h1 align="center">Endpoint Recorder</h1>

<p align="center">
  See how a web app talks to its backend.<br>
  Record the network calls of one browser tab and get a searchable map of endpoints, fields and real example responses.
</p>

<p align="center">
  <a href="https://github.com/lexvanwalsem/endpoint-recorder/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/lexvanwalsem/endpoint-recorder/actions/workflows/test.yml/badge.svg"></a>
  <img alt="Chrome extension, Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-0d7c75">
  <img alt="No dependencies" src="https://img.shields.io/badge/dependencies-none-0d7c75">
</p>

<p align="center">
  <img src="docs/full-view.png" alt="The full view: endpoint list on the left, details with a real example call on the right" width="900">
</p>

## Why

Most systems you integrate with do not come with good API documentation. Their web interface, however, already calls
the API for everything it shows. Endpoint Recorder watches those calls while you click through the interface and turns
them into documentation: which endpoints exist, what you send, what you get back, how often, how fast and how big.

Typical uses: figuring out an undocumented API, planning an integration, checking what a page really loads, comparing
what a system returns with what its documentation promises.

## Features

- **One tab at a time.** Switch it on for a tab from the toolbar icon; nothing else is watched.
- **Every kind of response.** JSON and form data are broken down into fields. HTML, XML and plain text are kept as text.
  Binary files and oversized responses are listed with their type and size.
- **Real example calls.** The full URL with query values, what was sent and what came back, as readable formatted JSON.
- **Field structure.** Per endpoint every field with its type(s) and how often it is present, so optional fields stand out.
- **Smart grouping.** Ids in paths become `{id}`. Calls that share one URL, such as JSON-RPC (Odoo) and GraphQL, are
  split by what they call (`mail.message.search_read`, the operation name).
- **Search and filter.** Search across paths, hosts, field names and the example data itself. Filter on method, host,
  request type and errors. Sort on calls, speed or recency.
- **Timing and size.** Average and slowest time, average and largest transfer size, status codes, content types.
- **Export.** Markdown for reading and sharing, JSON for processing. The export follows your filters.
- **Optional: all request types.** Also record pages, scripts, styles, images and fonts (type and size only for those).
- **Light and dark.** Follows your browser theme.

<p align="center">
  <img src="docs/popup.png" alt="The toolbar popup while recording" width="300">
</p>

## Install

The extension is not in the Chrome Web Store. Load it as an unpacked extension:

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and select the root folder of this repository (the folder that contains `manifest.json`).
4. Pin the extension (puzzle icon, then the pin) so the icon stays visible.

After changing the code, press the refresh icon on the extension card.

## Use

1. Open the web app in a tab and click the extension icon.
2. Press **Record this tab**. Chrome shows a bar saying "Endpoint Recorder started debugging this browser".
   Leave it open: closing it stops the recording.
3. Tick **Keep example values and sample calls** if you want the real requests and responses (see Privacy below).
4. Use the app as you normally would: open a ticket, reply to a mail, run a report. Press **Reload tab** if you also
   want the calls made while the page loads.
5. Click **Open full view** to search, filter and inspect. **Export Markdown** or **Export JSON** to take it with you.

## What you get

A Markdown export looks like this (shortened):

````markdown
## POST shop.example.com/web/dataset/call_kw/mail.message/search_read [mail.message.search_read]

- Calls: 9, average 164 ms, max 208 ms
- Transfer size: average 4.1 KB, max 4.1 KB
- Status codes: 200 x9
- Request content types: application/json x9
- Response content types: application/json x9

Example call: `POST https://shop.example.com/web/dataset/call_kw/mail.message/search_read` -> 200 (208 ms, 4.1 KB)

Response

```json
{ "jsonrpc": "2.0", "result": [{ "id": 8, "subject": "Where is my order 8?", "author_id": [8, "Fleur Meijer"] }] }
```

Response fields

| Field | Type | Present | Examples |
|---|---|---|---|
| $.result[].subject | string | 100% | Where is my order 8? |
| $.result[].author_id | array | 100% | |
````

## Privacy and safety

- **Everything stays on your computer.** The extension has no server, sends nothing anywhere and has no analytics.
  The recording lives in `chrome.storage.local` until you press **Clear** or remove the extension.
- **Request headers are not read**, with one exception: `Content-Type`, to know how to read a body. Cookies,
  authorization headers and tokens never enter the recording.
- **Example values and sample calls are opt-in.** Off by default, only field names and types are kept. When on, the
  latest three calls per endpoint are stored with their URL (including query values) and a shortened body. That can
  contain personal data or secrets that appear in URLs or bodies.
- **Treat exports like the data they come from.** Do not commit them or share them if they hold customer data.
- **Record only systems you are allowed to look into**, and respect their terms of use.

### Why these permissions

| Permission | Used for |
|---|---|
| `debugger` | Reads the Network events of the one tab you switch on, the same source as the DevTools Network tab. This is what makes response bodies readable. Chrome shows its "debugging" bar while it is active. |
| `storage` | Keeps the recording and your settings on your computer. |
| `activeTab` | Shows which site the current tab is. |

There are no host permissions and no code runs inside the pages you visit.

## How it works

The extension attaches the Chrome debugger to the tab and listens to its Network events. For each finished call it
collects method, URL, status, timing and size, and asks for the response body. `capture.mjs` turns the events into
calls, `recorder.mjs` groups them per endpoint, infers the field structure and keeps the examples. `viewer.html` shows
the result, `popup.html` controls the recording.

## Limits

- WebSocket and Server-Sent Events traffic is not captured.
- Bodies are read up to 50 MB; larger responses are listed with their size but without content.
- Binary bodies (images, PDF, archives) are not shown, only their type and size.
- Multipart uploads are listed, but their parts are not broken down.
- Example calls are shortened: the first 3 items of lists, texts cut at 200 characters (4000 for text bodies),
  60 keys per object and 8 levels deep. The field structure looks at the first 20 items of each list.
- Chrome internal pages (`chrome://`) and the Chrome Web Store cannot be recorded.

## Development

No build step and no dependencies. Node.js 20 or newer is only needed for the tests.

```sh
npm test
```

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker: attaches the debugger, stores calls |
| `capture.mjs` | Network events to finished calls (pure logic) |
| `recorder.mjs` | Grouping, field inference, examples, Markdown report (pure logic) |
| `popup.html`, `popup.js` | Toolbar popup |
| `viewer.html`, `viewer.js`, `viewer.css` | Full view page |
| `styles.css` | Shared design tokens and components |
| `test/` | Unit tests (`node --test`) |

## Contributing

Contributions are welcome as pull requests. The `main` branch is protected: every change is reviewed and approved by the
maintainer before it is merged. See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). You may use, copy and modify the code in your own version. Changes to this repository are only
accepted through pull requests that the maintainer approves.
