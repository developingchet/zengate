# zengate

[![CI](https://github.com/developingchet/zengate/actions/workflows/ci.yml/badge.svg)](https://github.com/developingchet/zengate/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/zengate)](https://www.npmjs.com/package/zengate)
[![Docker Hub](https://img.shields.io/docker/v/developingchet/zengate?label=docker&sort=semver)](https://hub.docker.com/r/developingchet/zengate)
[![Socket](https://socket.dev/api/badge/npm/package/zengate)](https://socket.dev/npm/package/zengate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An **OpenAI-compatible API for OpenCode's free Zen models: no Zen account or upstream API key needed.**
Point any OpenAI SDK or tool at it and use models like `big-pickle`. It supports Chat Completions, the Responses API, streaming, function calling, JSON output and image, audio, video and PDF input.

```
your app ──(OpenAI API + gateway key)──▶ zengate ──▶ opencode serve (private, isolated) ──▶ OpenCode Zen free models
```

- [How it works](#how-it-works-and-why-it-is-keyless)
- [Install](#install)
- [Use it from your client](#use-it-from-your-client)
- [API compatibility](#api-compatibility)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it works (and why it is keyless)

OpenCode's free Zen models only work from inside OpenCode. So this gateway does not imitate OpenCode. It **runs the real OpenCode CLI** (`opencode serve`, installed automatically as an npm dependency) as a private backend and translates between the OpenAI API and OpenCode sessions:

- Every API request becomes a short-lived OpenCode session, which is deleted afterwards.
- OpenCode runs sandboxed. It listens only on `127.0.0.1` with a random password, and its home and config directories are throwaway temp dirs, so your own OpenCode or Claude settings, agents and plugins are never loaded.
- **OpenCode's own tools are always refused.** Every tool permission is set to "ask" and the gateway rejects each request automatically. Nothing ever runs a command, edits a file or fetches a URL on your machine.
- Your API key protects *the gateway*. Nothing upstream needs a key.

Trade-offs to know about:

- **Prompt overhead.** Each request carries OpenCode's system prompt and tool list (roughly 6–9k input tokens, largely cache hits), and adds about 1–3 s of latency.
- **Sampling parameters are ignored.** Settings like `temperature` and `max_tokens` cannot be forwarded through OpenCode. The gateway accepts them and lists them in an `x-gateway-ignored-params` response header.
- **Upstream terms apply.** Availability, rate limits and the model list are set by OpenCode Zen and can change at any time. Free models may have their own data policies; see the [Zen docs](https://opencode.ai/docs/zen/).

> **Fair use.** zengate talks to Zen only through the official OpenCode CLI and never bypasses its limits or free-tier checks. You are responsible for following OpenCode's terms and fair-use expectations. Run it for yourself or your team, not as a public or resold service.

## Install

Pick one. All of them need nothing but Node.js 24+ or Docker.

**npx (quickest)**

```bash
npx zengate
```

**npm (global command)**

```bash
npm install -g zengate
zengate
```

**Docker**

```bash
docker run -d --name zengate -p 127.0.0.1:8083:8083 -v zengate:/data developingchet/zengate
docker logs zengate   # shows the generated key once
```

Images are published for `linux/amd64` and `linux/arm64`, tagged `latest`, `1`, `1.2` and `1.2.3`.

**Docker Compose**

```yaml
services:
  zengate:
    image: developingchet/zengate:1
    restart: unless-stopped
    ports:
      - "127.0.0.1:8083:8083"
    volumes:
      - zengate:/data
volumes:
  zengate:
```

**From source**

```bash
git clone https://github.com/developingchet/zengate.git
cd zengate
npm ci
npm start
```

### First start

The gateway creates a config file with a random API key and prints the key once:

```
  Created a gateway API key (saved to /home/you/.config/zengate/config.json):

    sk-zg-...

OpenAI-compatible API on http://127.0.0.1:8083/v1 (auth: API key)
7 models: big-pickle, ...
```

Where the config file lives:

| How you run it | Config file |
|---|---|
| From source | `config.json` in the project folder |
| npm / npx on Linux | `$XDG_CONFIG_HOME/zengate/config.json` (usually `~/.config/zengate/config.json`) |
| npm / npx on macOS | `~/Library/Application Support/zengate/config.json` |
| npm / npx on Windows | `%APPDATA%\zengate\config.json` |
| Docker | `/data/config.json` (the volume) |

Set `CONFIG_FILE` to use any other path.

Key commands (`npm run setup -- <flag>` from a source checkout):

```bash
zengate setup            # create a key if none exists
zengate setup --rotate   # replace the key
zengate setup --print    # print a fresh key without saving it (for env vars and secret stores)
zengate --help
```

### Running without a key

If only trusted local programs can reach the port, you can turn authentication off explicitly:

```bash
ALLOW_NO_AUTH=true zengate
```

The gateway warns at startup when auth is off. Keep `HOST=127.0.0.1` in that case: with auth off, any local process can use the API, and so can any web page if you enable CORS.

## Use it from your client

Anything that accepts an OpenAI base URL and API key works: the official SDKs, LangChain, LlamaIndex, Open WebUI, Continue, Aider, LiteLLM and so on.

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8083/v1` |
| API key | the `sk-zg-...` key from first start |
| Model | an id from `GET /v1/models`, for example `big-pickle` |

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8083/v1
export OPENAI_API_KEY=sk-zg-...
```

**Python**

```python
from openai import OpenAI
client = OpenAI()  # reads the two variables above
r = client.chat.completions.create(model="big-pickle", messages=[{"role": "user", "content": "Hello!"}])
print(r.choices[0].message.content)
```

**JavaScript / TypeScript**

```js
import OpenAI from "openai";
const client = new OpenAI(); // reads the two variables above
const stream = await client.responses.create({ model: "big-pickle", input: "Write a haiku about gates.", stream: true });
for await (const event of stream) if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
```

**curl**

```bash
curl http://127.0.0.1:8083/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"Hello!"}]}'
```

## API compatibility

| Endpoint | Status |
|---|---|
| `POST /v1/chat/completions` | Streaming (SSE, `stream_options.include_usage`), `n` 1–4, `stop`, `tools` / `tool_choice` / `parallel_tool_calls`, legacy `functions`, `response_format` (`json_object`, `json_schema`), `reasoning_effort`, `developer` / `system` / `tool` roles, `reasoning_content` in responses |
| `POST /v1/responses` | Streaming with the standard event sequence, `instructions`, `previous_response_id`, `item_reference`, `function` and `custom` tools, `text.format`, `reasoning.effort` / `reasoning` summary items, `store` |
| `GET` / `DELETE /v1/responses/{id}` | Stored in memory for 1 hour, up to `RESPONSES_STORE_MAX` entries |
| `GET /v1/models`, `GET /v1/models/{id}` | Live list from OpenCode |
| `GET /health`, `GET /ready` | Public liveness and readiness probes |
| `GET /metrics` | Request counters and slot usage, as JSON (needs the key) |

Routes also work without the `/v1` prefix. Errors use the standard OpenAI envelope, `{"error": {"message", "type", "param", "code"}}`, with matching HTTP status codes (400, 401, 404, 413, 429 with `Retry-After`, 502, 503, 504).

**Inputs** (validated against each model's capabilities; a model that can't take an input returns `400 unsupported_modality`):

| Kind | Chat Completions | Responses |
|---|---|---|
| Text | `text` parts | `input_text` |
| Images | `image_url` (data URI or https) | `input_image` |
| Audio | `input_audio` (base64) | `input_audio` |
| Video | `video_url` | `input_video` |
| PDF / files | `file` (`file_data` data URI) | `input_file` (`file_data` / `file_url`) |

Text files (plain text, markdown, JSON, CSV and so on) are inlined as text, so every model can read them.

**Function calling** is emulated. OpenCode sessions cannot register your functions natively, so their schemas go into the prompt and the model's calls come back as standard `tool_calls` or `function_call` items. It works reliably with `big-pickle`. If a model tries to call a function the wrong way, or ignores `tool_choice: "required"`, the gateway retries once with a correction.

**Not supported** (clear 400 error): `logprobs`, audio output, `file_id` references (there is no Files API), `background` responses, the Conversations API and stored prompts. Hosted tools such as `web_search` in Responses are ignored and listed in `x-gateway-ignored-params`.

## Configuration

Set values as environment variables or in the config file (same names; see [`config.json.example`](config.json.example)). Environment variables win. Invalid values stop startup with a clear message.

| Setting | Default | Meaning |
|---|---|---|
| `API_KEY` / `API_KEYS` | generated | Gateway key(s), at least 16 characters. `API_KEYS` takes a list for rotation. |
| `ALLOW_NO_AUTH` | `false` | Serve without any key (explicit opt-out). |
| `HOST` / `PORT` | `127.0.0.1` / `8083` | Listen address. |
| `MAX_CONCURRENT` / `MAX_QUEUE` | `8` / `32` | Parallel generations, and how many requests may wait (then `429`). |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per client IP (`0` turns it off). |
| `REQUEST_TIMEOUT_MS` | `300000` | Per generation (then `504`). |
| `MAX_BODY_MB` / `MAX_MEDIA_MB` | `25` / `20` | Request body limit, and the limit per attachment. |
| `RESPONSES_STORE_MAX` | `500` | Stored responses for `previous_response_id` (`0` turns storage off). |
| `CORS_ORIGINS` | none | Browser origins allowed to call the API (explicit list; `*` is refused). |
| `TRUST_PROXY` | `0` | Number of reverse-proxy hops to trust for client IPs. |
| `LOG_LEVEL` / `LOG_JSON` | `info` / `false` | Log verbosity, and JSON-lines output. |
| `OPENCODE_AGENT` | `plan` | The OpenCode agent each session uses. |
| `OPENCODE_PATH` | bundled | Use a different `opencode` binary. |
| `OPENCODE_SERVER_URL` | none | Attach to an existing `opencode serve` instead of starting one (see below). |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | `opencode` / none | Basic auth for that server. |
| `ALLOW_INSECURE_BACKEND_HTTP` | `false` | Allow a non-loopback `http://` server URL. |
| `CONFIG_FILE` | see [First start](#first-start) | Where the config file lives (environment variable only). |

**Attach mode.** `OPENCODE_SERVER_URL` uses a server you run yourself. The gateway can only reject tool calls that server *asks* permission for; that happens in its own sessions and their subagents. It trusts the server's own permission config, plugins and MCP servers. If that config allows tools without asking, they will run. Use it only with a server configured like the managed one (every permission set to `"ask"`). The managed default is safer. Remote servers must use `https://` unless you set `ALLOW_INSECURE_BACKEND_HTTP`.

## Deployment

**Docker.** The key persists in the `/data` volume. You can pass `-e API_KEY=...` instead. Publish the port on `127.0.0.1`, or put a TLS reverse proxy in front before exposing it to a network.

**systemd.** See [`deploy/zengate.service`](deploy/zengate.service). It runs as an unprivileged user with a hardened sandbox, and the key goes in `/var/lib/zengate/config.json`.

**Behind a reverse proxy.** Set `TRUST_PROXY=1` (or however many hops you have) so rate limits apply per real client. Disable response buffering for streaming. The gateway already sends `X-Accel-Buffering: no` for nginx.

### Verifying releases

Docker images are signed with [cosign](https://github.com/sigstore/cosign) (keyless, from this repository's release workflow) and carry a CycloneDX SBOM attestation:

```bash
cosign verify developingchet/zengate:1 \
  --certificate-identity-regexp '^https://github.com/developingchet/zengate/.github/workflows/release.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

npm releases are published from GitHub Actions with [provenance](https://docs.npmjs.com/generating-provenance-statements); `npm audit signatures` checks it. Each GitHub release also lists SHA-256 checksums.

## Security

- The API key is required unless you set `ALLOW_NO_AUTH`. Keys are compared in constant time, the config file is written with mode `0600`, and keys are never logged.
- The gateway binds to loopback by default and warns when it listens elsewhere, because traffic is plain HTTP, so put TLS in front.
- OpenCode tools are never executed, and OpenCode runs isolated from your home directory and configuration.
- Attachment URLs must be `https` and resolve to public addresses. Loopback, private, link-local and similar ranges are refused, which blocks SSRF into your network.
- Rate limiting, a bounded queue, body and attachment size limits, and per-request timeouts all apply. A request with `n` choices uses `n` concurrency slots, and slots are always released on disconnect or timeout.
- Stored responses (`previous_response_id`, `GET /v1/responses/{id}`) are visible only to the API key that created them.
- The gateway sends no telemetry and never logs request bodies. OpenCode's auto-update and session sharing are disabled.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 invalid_api_key` | Send `Authorization: Bearer <key from the config file>`. |
| `404 model_not_found` | Use an id from `GET /v1/models`. The free model list changes over time. |
| `400 unsupported_modality` | That model can't take this input kind. Pick one that does. |
| `429 server_busy` / `rate_limit_exceeded` | Raise `MAX_CONCURRENT` / `MAX_QUEUE` / `RATE_LIMIT_PER_MINUTE`, or slow down. |
| `429 upstream_rate_limited`, `502 upstream_*` | OpenCode Zen is limiting or failing. Retry later or try another model. |
| `503 backend_unavailable` | OpenCode is still starting or restarting. Check `GET /ready`. Run with `LOG_LEVEL=debug` to see OpenCode's own logs. |
| Startup: `Port ... in use` | Another process has the port. Set `PORT`. |
| Startup: `could not be written` | The config folder is read-only. Set `API_KEY`, or point `CONFIG_FILE` somewhere writable. |

## Development

```bash
npm test               # unit + integration tests (fake OpenCode server)
npm run test:coverage
npm run lint           # syntax, file size and hygiene checks
GATEWAY_URL=http://127.0.0.1:8083/v1 API_KEY=sk-zg-... npm run test:live   # real models
```

Code map:
- `index.js` and `src/cli.js`: the `zengate` command.
- `src/opencode/`: backend supervisor, HTTP client, event hub, session runner and model catalog.
- `src/openai/`: request parsing, prompt building, streaming, and the Chat and Responses handlers.
- `src/server/`: Express app, auth, limits and errors.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes and cut releases, and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

MIT. zengate is an independent project, not affiliated with OpenCode or OpenAI.
