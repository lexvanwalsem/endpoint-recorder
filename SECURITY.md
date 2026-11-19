# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting
(the "Security" tab of this repository, then "Report a vulnerability").

Include what you found, how to reproduce it and what the impact could be. You will get a reply as soon as possible.

## What the extension does and does not do

- It sends no data anywhere; the recording stays in the browser's local extension storage.
- It never stores the value of a cookie, authorization header or token header. Of those it keeps at most a short fingerprint (12 characters of a SHA-256). Other headers are kept as names, plus a short list of harmless values (see the README). The setting "Analyse headers" turns it off.
- It has no host permissions and runs no code inside the pages you visit.
- Recordings can contain personal data when "Keep example values and sample calls" is on. Handle exports accordingly.
