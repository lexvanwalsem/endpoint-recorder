# Contributing

Thanks for wanting to help. Pull requests are welcome.

## How changes are accepted

- The `main` branch is protected. Nobody pushes to it directly.
- Every change goes through a pull request that the maintainer reviews and approves before merging.
- The automated tests must pass.

## Before you open a pull request

1. Open an issue first for anything bigger than a small fix, so we agree on the direction.
2. Fork the repository, create a branch, make your change.
3. Run the tests: `npm test` (Node.js 20 or newer).
4. Add or update tests for the behaviour you change. The logic lives in `capture.mjs` and `recorder.mjs` and has no
   browser dependencies, which keeps it easy to test.
5. Keep it simple: no new dependencies, no build step, no external requests.
6. Raise the `version` in `manifest.json` when the change is visible to users.

## Style

- English for code, comments and interface text.
- Small functions, clear names, comments that explain why.
- Never use `innerHTML` with recorded data; build DOM nodes with text.
- Keep privacy in mind: the extension must never store the value of a cookie, token or other secret (only header names, the harmless values listed in `headers.mjs` and fingerprints), and must never send
  data anywhere.

## Reporting a bug

Open an issue with the Chrome version, the steps, what you expected and what happened. Do not attach recordings or
exports that contain personal data.
