# Security Policy

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through [GitHub private vulnerability reporting](https://github.com/developingchet/zengate/security/advisories/new) (the **Security** tab, then **Report a vulnerability**).

Please include:
- the zengate version or commit, and how you run it (Docker, systemd, `npm start`)
- the relevant configuration, with keys removed
- steps to reproduce, and the impact you expect

GitHub keeps the report confidential until a fix is released.

## Response timeline

- Acknowledgement within 3 business days.
- A status update within 7 business days.
- A fix within 30 days of a confirmed reproduction. Critical issues (CVSS 9.0 or higher) are expedited on a best-effort basis.

Disclosure is coordinated with the reporter, who is credited in the release notes unless they prefer otherwise.

## Scope

In scope:
- bypassing API key authentication, or reading another key's stored responses
- server-side request forgery through attachment URLs
- getting OpenCode to execute tools, read files or reach anything outside its isolated environment
- leaking the API key, the backend password or request content in logs or error messages
- denial of service that gets past the built-in rate, size, time or concurrency limits

Out of scope:
- problems in OpenCode, OpenCode Zen or the upstream models themselves (report those to OpenCode)
- deployments that turn protections off on purpose, such as `ALLOW_NO_AUTH=true` on a public network, or serving plain HTTP without TLS
- model output content, including prompt injection that only affects the model's own text

## Hardening

See the [Security summary](README.md#security-summary) in the README for the defaults and deployment advice.
