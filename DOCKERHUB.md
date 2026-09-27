# zengate

**An OpenAI-compatible API for OpenCode's free Zen models: no Zen account or upstream API key needed.**

Point any OpenAI SDK or tool at it and use models like `big-pickle`: Chat Completions, the Responses API, streaming, function calling, JSON output, and image, audio, video and PDF input. Source, docs and issues: **[github.com/developingchet/zengate](https://github.com/developingchet/zengate)**.

## Quick start

```bash
docker run -d --name zengate -p 127.0.0.1:8083:8083 -v zengate:/data developingchet/zengate
docker logs zengate   # prints the generated API key once
```

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

The full list is in the [README](https://github.com/developingchet/zengate#configuration).

## Image details

- Platforms: `linux/amd64`, `linux/arm64`.
- Tags: `latest`, `1`, `1.2`, `1.2.3` (pre-releases only get their exact version tag).
- Runs as the unprivileged `node` user, listens on port `8083`, and has a built-in health check on `/ready`.
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
