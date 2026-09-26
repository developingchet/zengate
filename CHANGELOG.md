# Changelog

## 2.0.0 (2026-09-26)

Rebuilt from scratch and renamed to **zengate**.

### Changed
- The gateway now runs the real OpenCode CLI (`opencode serve`, bundled via the `opencode-ai` npm package) as a private, isolated backend. It no longer calls Zen directly, which OpenCode's free tier rejects.
- An API key is required by default. One is generated on first start, saved to `config.json` (mode 0600) and printed once. `ALLOW_NO_AUTH=true` turns auth off explicitly.
- Configuration now uses plain names such as `HOST`, `PORT` and `MAX_CONCURRENT`. Unknown keys and invalid values stop startup with a clear message, and a malformed `config.json` is fatal.
- Requires Node.js 24 or newer.

### Added
- Full `/v1/chat/completions` and `/v1/responses` support:
  - streaming, `n`, `stop`, `reasoning_effort`, and `json_schema` / `json_object` output
  - function calling (including legacy `functions`), the `developer` role, and `previous_response_id`
  - image, audio, video and PDF input
- `GET /v1/models/{id}`, `GET`/`DELETE /v1/responses/{id}`, `/ready` and `/metrics`.
- Docker image with a `/data` volume for the key, a hardened systemd unit, and a CI matrix on Linux, Windows and macOS.
- 299 automated tests (unit, plus integration against a fake OpenCode server) and a live end-to-end script (`npm run test:live`).

### Security
- OpenCode tool calls are always rejected, including in subagent sessions, so nothing ever executes on the host.
- Attachment URLs must be https and resolve to public addresses (SSRF protection).
- Stored responses are scoped to the API key that created them.
- Concurrency slots are weighted by `n` and always released on timeout or disconnect. A request fails fast when the upstream keeps failing.
