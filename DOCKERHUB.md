# zengate

**An OpenAI-compatible API for OpenCode's free Zen models: no Zen account or upstream API key needed.**

Point any OpenAI SDK or tool at it and use models like `big-pickle`: Chat Completions, the Responses API, streaming, function calling, JSON output, and image, audio, video and PDF input. Source, docs and issues: **[github.com/developingchet/zengate](https://github.com/developingchet/zengate)**.

## Quick start

```bash
docker run -d --name zengate -p 127.0.0.1:8083:8083 -v zengate:/data developingchet/zengate
docker exec zengate node index.js setup --show   # prints the generated API key
```

The same image, with the same tags and digest, is also published as `ghcr.io/developingchet/zengate`.

Then use `http://127.0.0.1:8083/v1` as the OpenAI base URL and the `sk-zg-...` key as the API key:

```bash
curl http://127.0.0.1:8083/v1/chat/completions \
  -H "Authorization: Bearer sk-zg-..." -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"Hello!"}]}'
```

## Docker Compose

```yaml
services:
  zengate:
    image: developingchet/zengate:1
    restart: unless-stopped
    ports:
      - "127.0.0.1:8083:8083"
    volumes:
      - zengate:/data
    stop_grace_period: 20s
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs: [/tmp]
volumes:
  zengate:
```

## Configuration

The key is stored in `/data/config.json` (mode 0600) on the volume. Everything else is set with environment variables, for example:

| Variable | Default | Meaning |
|---|---|---|
| `API_KEY` | generated | Use your own key (at least 16 characters) instead of a generated one. |
| `MAX_CONCURRENT` / `MAX_QUEUE` | `8` / `32` | Parallel generations, and how many requests may wait. |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per client IP (`0` turns it off). |
| `TRUST_PROXY` | `0` | Reverse-proxy hops to trust for client IPs. |
| `LOG_LEVEL` / `LOG_JSON` | `info` / `false` | Log verbosity, and JSON-lines output. |
| `OPENCODE_PROFILE` | `compatible` | Set to `chat` for the opt-in strict text-only profile described below. |

The full list is in the [README](https://github.com/developingchet/zengate#configuration).

## Profiles and upstream limits

Version 1.4.0 bundles OpenCode 2.1.2. The default `compatible` profile retains OpenCode's coding instructions and host-tool descriptions; the managed gateway rejects host-tool execution. Tool rejection does not make backend instructions confidential.

For strict text-only requests, add `-e OPENCODE_PROFILE=chat` to `docker run`, or set `environment: { OPENCODE_PROFILE: chat }` in Compose. This profile selects the dedicated `zengate-chat` agent, removes backend workspace/environment context and host-tool schemas from provider input, denies permissions and disables auxiliary calls and automatic retries. Leave `OPENCODE_AGENT` at its default or use `zengate-chat`. Attached servers and runtimes other than OpenCode 2.1.2 are refused; media returns `400 unsupported_modality`.

Free-provider compatibility remains unverified for this release: the October 27, 2026 live `opencode/big-pickle` checks were quota-blocked or inconclusive. Local synthetic contract checks passed; [issue #38](https://github.com/developingchet/zengate/issues/38) remains open. Strict chat surfaces provider refusal and quota errors without restoring coding context or substituting another model/provider. See the [profile documentation](https://github.com/developingchet/zengate#strict-conversational-profile) for its boundary and limitations.

Upstream allowance exhaustion returns HTTP 429 with `upstream_quota_exhausted`; temporary throttling uses `upstream_rate_limited`. Validated provider timing is exposed in `Retry-After` and JSON `error.retry_after`, in seconds. Missing timing stays unknown. These limits belong to OpenCode Zen; changing gateway queue or concurrency settings does not replenish allowance.

## Image details

- Platforms: `linux/amd64`, `linux/arm64`.
- Tags: `latest`, `1`, `1.4`, `1.4.0` (pre-releases only get their exact version tag).
- Runs as the unprivileged `node` user, listens on port `8083`, and has a built-in health check on `/ready`.
- Works with a read-only root filesystem: only `/tmp` and `/data` need to be writable.
- The gateway's own traffic is plain HTTP. Publish the port on `127.0.0.1`, or put a TLS reverse proxy in front.

## Supply chain

Every image is built in GitHub Actions, scanned with Trivy, signed with cosign (keyless) and carries a CycloneDX SBOM attestation and build provenance.

```bash
cosign verify developingchet/zengate:1 \
  --certificate-identity-regexp '^https://github.com/developingchet/zengate/.github/workflows/release.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Fair use

zengate talks to Zen only through the official OpenCode CLI and never bypasses its limits or free-tier checks. Follow OpenCode's terms: run it for yourself or your team, not as a public or resold service. zengate is an independent project, not affiliated with OpenCode or OpenAI. MIT licensed.
