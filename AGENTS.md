# AGENTS.md

## Project

zengate is an OpenAI-compatible HTTP gateway for OpenCode's free Zen models. It runs the real OpenCode CLI
(`opencode serve`) as a private managed backend on loopback with a random password, translates OpenAI Chat
Completions and Responses requests into short-lived OpenCode sessions, and needs no upstream API key. The
gateway's own API key protects access to it. There is no build step; the only runtime dependencies are Express
and `@opencode/cli`. The README's "How it works" section describes the trust boundaries and trade-offs.

| Path | Contents |
|---|---|
| `index.js`, `src/cli.js` | The `zengate` command and its setup flags. |
| `src/config.js`, `src/bootstrap.js`, `src/paths.js`, `src/node-version.js` | Settings, first-run key creation, config paths and the Node version check. |
| `src/gateway.js` | Startup, backend wiring, graceful shutdown and readiness. |
| `src/server/` | Express app, auth, CORS, rate and size limits, concurrency slots, metrics and OpenAI-format errors. |
| `src/opencode/` | Managed backend supervisor, isolation, CLI detection, HTTP clients, event hub, session runner, model catalog and the strict-chat plugin. |
| `src/openai/` | Request parsing, prompt building, media and attachment downloads, streaming, stored responses and the Chat, Responses and Completions handlers. |
| `scripts/` | `setup.mjs` (key setup), `quality.mjs` (lint), and the live, leak and backend-contract checks. |
| `test/` | `node:test` suites; property-based tests use fast-check and live in `*.test.js`. |
| `.github/workflows/` | CI, image scanning, release, Scorecard and Socket workflows; all actions are pinned to commit SHAs. |
| `config.json.example`, `deploy/zengate.service` | Example settings and the systemd unit. |

## Setup and checks

Node.js 24 or later. `npm ci` installs the runtime dependencies and fast-check for tests; the tests use a fake
OpenCode server and need no account, network or API key.

```bash
npm ci
npm run lint                   # syntax, 800-line file cap, forbidden markers and stray artifacts
npm test                       # unit, integration and property-based tests
npm run test:coverage
npm run verify                 # lint plus test
npm run audit                  # npm audit of production dependencies
npm run test:backend-contract  # bundled real CLI, synthetic local provider
npm start                      # creates config.json with a key on first start
```

`npm run test:live`, `npm run test:leak` and `npm run test:chat-live` need a running gateway or a real provider
and are outside CI; [CONTRIBUTING.md](CONTRIBUTING.md) describes them. CI runs lint, tests with coverage and
the backend contract on Linux and Windows, the dependency audit, a Docker build with a `/ready` smoke test and
Trivy, and the Socket scan. CodeQL default setup also runs.

## Conventions

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`, `ci:`). Pull
  requests are squash-merged with linear history and need one approving review.
- Keep files focused and under 800 lines, and functions small. `npm run lint` enforces the file cap and
  rejects forbidden markers and stray artifacts.
- Add or update a `node:test` test for every behaviour change. Property-based tests use fast-check and the
  `.js` extension so OpenSSF Scorecard detects them.
- Validate input at the boundary and return errors in the OpenAI envelope. Never log request bodies or keys.
  Attachment URLs appear in errors and logs as their origin only.
- Update the README and `CHANGELOG.md` (under **Unreleased**) when behaviour or configuration changes. A new
  setting belongs in `config.json.example`, the README Configuration table and the docs that describe it.
- An `@opencode/cli` upgrade needs `CHAT_RUNTIME_VERSION` in `src/opencode/chat-plugin.js` moved to the same
  version; run `npm run test:backend-contract` and `npm run test:leak` before raising it.
- Keep the runtime dependency list small, keep the `overrides` that replace Express polyfills, and prefer the
  Node.js standard library. Every `npm ci` in CI goes through Socket Firewall.

## Security boundaries

- The managed backend listens on `127.0.0.1` with a random password and throwaway home and config
  directories. That is configuration isolation, not an operating-system sandbox. Host tools are refused, and
  strict `OPENCODE_PROFILE=chat` removes the backend context and host-tool list entirely. Do not weaken those
  denials or forward workspace context past the documented provider-input boundary.
- The gateway key protects the gateway only; nothing upstream needs a key. Stored responses stay visible to the
  API key that created them. `ALLOW_NO_AUTH` is an explicit opt-out; keep the host guard and the IP-only Host
  rule that stops DNS rebinding.
- Never commit `config.json`, `.env` files, keys, certificates or logs with request content. Tests and
  examples use placeholder keys and documentation addresses.
- Report security problems through
  [private vulnerability reporting](https://github.com/developingchet/zengate/security/advisories/new), never a
  public issue; see [SECURITY.md](SECURITY.md). Reproduce problems only in systems you own or are authorized
  to test, and keep third-party code and unfixed vulnerabilities in someone else's project out of public
  issues.

## Local agent files

`AGENTS.md` is the shared, committed guide. `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` are local Claude
Code files, stay ignored and are never committed.

## Pull requests

Fill in `.github/PULL_REQUEST_TEMPLATE.md`: list the checks run and those skipped, say what was not tested,
and note any change to authentication, backend tool denial, the strict chat boundary, config defaults or what
is logged, with a rollback plan.
