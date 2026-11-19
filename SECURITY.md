# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting
(the "Security" tab of this repository, then "Report a vulnerability").

Include what you found, how to reproduce it and what the impact could be. You will get a reply as soon as possible.

## What the extension does and does not do

- It sends no data anywhere; the recording stays in the browser's local extension storage.
- It reads no request headers except `Content-Type`.
- It has no host permissions and runs no code inside the pages you visit.
- Recordings can contain personal data when "Keep example values and sample calls" is on. Handle exports accordingly.
