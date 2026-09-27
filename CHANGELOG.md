# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/developingchet/zengate/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/developingchet/zengate/releases/tag/v1.0.3
[1.0.2]: https://github.com/developingchet/zengate/releases/tag/v1.0.2
[1.0.1]: https://github.com/developingchet/zengate/releases/tag/v1.0.1
[1.0.0]: https://www.npmjs.com/package/zengate/v/1.0.0
