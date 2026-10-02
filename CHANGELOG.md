# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `QUEUE_TIMEOUT_MS` (default 30s): a request that cannot get a slot in time gets `429 server_busy` instead of waiting silently until a proxy gives up. `REQUEST_TIMEOUT_MS` now starts once the request has a slot.
- `SHUTDOWN_TIMEOUT_MS` (default 10s) sets how long a shutdown waits for in-flight requests, and `/ready` answers `503` with `"status": "stopping"` as soon as shutdown begins.
- `RESPONSES_STORE_MB` (default 256) caps the approximate memory of stored responses, on top of the `RESPONSES_STORE_MAX` entry count.
- An access-log line for each API request (method, path, status, duration, client), at `info` level.
- A clear error on Node.js versions older than 24.

### Changed
- The Socket scan runs on pull requests and pushes to `main` only, no longer weekly. Dependabot alerts and the weekly CI audit already report new advisories in the lockfile.
- `opencode-ai` is pinned to an exact version, so `npm install -g` and `npx` get the OpenCode release the gateway was tested with.
- `/ready` no longer reports the OpenCode version; `/metrics` (which needs the key) does.
- Earlier assistant messages of a turn are fetched from OpenCode in parallel.

### Fixed
- If restarting a crashed OpenCode backend failed before the process started (for example, the binary was briefly missing), the gateway stopped retrying and stayed unavailable. It now keeps retrying with backoff.
- Backend scratch directories left by a killed container were never removed, because the restarted gateway had the same pid. A gateway killed outright no longer leaves its OpenCode process running on Linux; the next start stops it.
- Request bodies are read under a 120-second deadline, so a client can no longer hold a connection open by sending its body very slowly.

### Security
- The gateway downloads `https` attachments itself and gives OpenCode the content, instead of letting OpenCode fetch the URL. Every connection, including each redirect, goes only to the address that passed the public-address check, so redirects and DNS rebinding cannot reach internal hosts, and remote files are held to `MAX_MEDIA_MB` and `MAX_BODY_MB`.
- The address check also refuses IPv4-mapped and IPv4-translated IPv6 in every notation, IPv4-compatible, 6to4, Teredo and other special-purpose IPv6 ranges, while NAT64 addresses are judged by the IPv4 address they carry.
- Message text, file names, tool names and call ids are escaped in the conversation transcript, so a message cannot pose as another turn, a tool result or a function call.
- Requests that are uploading, queued or running are capped at `MAX_CONCURRENT + MAX_QUEUE`, so concurrent large uploads can no longer hold unbounded memory before reaching the queue.
- The systemd unit adds `ProtectProc=invisible`, `ProtectClock`, `ProtectHostname`, `ProtectKernelLogs` and `RestrictRealtime`, and the Compose example drops all capabilities and sets `no-new-privileges`.

## [1.0.4] - 2026-09-27

### Added
- Property-based tests (fast-check) for stop sequences, the SSRF address guard and CORS header handling. They run hundreds of generated inputs per property.

### Security
- A weekly Trivy scan of the published Docker Hub image (amd64 and arm64) reports to the Security tab. CI and the Socket scan of `main` also run weekly.
- OpenSSF Scorecard grades the repository's security practices weekly, with a badge in the README.
- GitHub releases include cosign signatures (`*.sigstore.json`) for `checksums.txt` and the package tarball.
- The Docker base image is pinned by digest, the Socket CLI is installed from a hash-locked requirements file, and releases no longer install npm from the registry (Node 24 already ships a new enough npm).

## [1.0.3] - 2026-09-26

### Fixed
- The Socket badge in the README renders on GitHub and npm.
- The Socket scan of `main` records a baseline scan instead of failing while looking up pull request comments.

## [1.0.2] - 2026-09-26

### Changed
- CORS is handled by a small built-in middleware instead of the `cors` package (exact origin matching, no credentials, validated preflight headers).
- `overrides` replace polyfills in Express's dependency tree with maintained `@socketregistry` packages; the installed dependency tree shrinks from 81 to 65 packages.
- The npm package lists its author.

### Security
- Every dependency install in CI and releases goes through Socket Firewall, and a Socket scan checks dependency changes in pull requests.
- SECURITY.md documents the supply chain and the expected dependency alerts.
- Added a Code of Conduct and CODEOWNERS.

## [1.0.1] - 2026-09-26

First release published everywhere: Docker Hub, npm (with provenance) and GitHub Releases.

### Security
- The `Authorization` header is parsed without a regular expression, so no header can trigger slow backtracking.
- API keys are compared byte for byte in constant time and are no longer hashed; stored responses are scoped by which configured key matched.

## [1.0.0] - 2026-09-26

First public release (npm only).

### Added
- An OpenAI-compatible API for OpenCode's free Zen models. It runs the real OpenCode CLI (`opencode serve`, bundled through the `opencode-ai` npm package) as a private, isolated backend, so no Zen API key is needed.
- Full `/v1/chat/completions` and `/v1/responses` support:
  - streaming, `n`, `stop`, `reasoning_effort`, and `json_schema` / `json_object` output
  - function calling (including legacy `functions`), the `developer` role, and `previous_response_id`
  - image, audio, video and PDF input
- `GET /v1/models`, `GET /v1/models/{id}`, `GET`/`DELETE /v1/responses/{id}`, `/health`, `/ready` and `/metrics`.
- An API key is required by default. One is generated on first start, saved to `config.json` (mode 0600) and printed once. `ALLOW_NO_AUTH=true` turns auth off explicitly.
- Plain configuration names such as `HOST`, `PORT` and `MAX_CONCURRENT`. Unknown keys and invalid values stop startup with a clear message.
- A `zengate` command (`npx zengate`, `npm install -g zengate`) with `setup`, `--help` and `--version`. When installed from npm, the config file lives in the per-user config directory.
- Docker images for `linux/amd64` and `linux/arm64` on Docker Hub (`developingchet/zengate`), with a `/data` volume for the key.
- Signed releases: images are scanned with Trivy, signed with cosign and carry an SBOM attestation; npm packages are published with provenance; GitHub releases include checksums.
- A hardened systemd unit, and a CI matrix on Linux, Windows and macOS.
- 309 automated tests (unit, plus integration against a fake OpenCode server) and a live end-to-end script (`npm run test:live`).

### Security
- OpenCode tool calls are always rejected, including in subagent sessions, so nothing ever executes on the host.
- Attachment URLs must be https and resolve to public addresses (SSRF protection).
- Stored responses are scoped to the API key that created them.
- Concurrency slots are weighted by `n` and always released on timeout or disconnect. A request fails fast when the upstream keeps failing.

[Unreleased]: https://github.com/developingchet/zengate/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/developingchet/zengate/releases/tag/v1.0.4
[1.0.3]: https://github.com/developingchet/zengate/releases/tag/v1.0.3
[1.0.2]: https://github.com/developingchet/zengate/releases/tag/v1.0.2
[1.0.1]: https://github.com/developingchet/zengate/releases/tag/v1.0.1
[1.0.0]: https://www.npmjs.com/package/zengate/v/1.0.0
