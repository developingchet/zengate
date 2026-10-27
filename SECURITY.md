# Security Policy

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
| ------- | --------- |
| Latest stable release | Yes |
| Older releases | No |

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
- bypassing managed OpenCode host-tool denial to execute commands, read host files or reach the network
- strict `OPENCODE_PROFILE=chat` forwarding backend workspace/environment context or host-tool schemas contrary to its documented provider-input boundary
- leaking the API key, the backend password or request content in logs or error messages
- denial of service that gets past the built-in rate, size, time or concurrency limits

Out of scope:
- problems in OpenCode, OpenCode Zen or the upstream models themselves (report those to OpenCode)
- deployments that turn protections off on purpose, such as `ALLOW_NO_AUTH=true` on a public network, or serving plain HTTP without TLS
- model output content, including prompt injection that only affects the model's own text and does not cross the documented context or tool boundary; universal prompt secrecy is not guaranteed

## Supply chain

- Releases are built only in GitHub Actions from a version tag. Docker images are scanned with Trivy, then signed with cosign and given an SBOM attestation on both Docker Hub and GHCR; npm packages on npmjs.com are published through npm trusted publishing with provenance. See [Verifying releases](README.md#verifying-releases).
- Every npm dependency install in CI goes through Socket Firewall. The Python Socket CLI uses a separate hash-locked requirements file. Pull requests are scanned by Socket and CodeQL, and Dependabot tracks npm, Python CI tooling, GitHub Actions and the Docker base image. All actions are pinned to commit SHAs.
- Every week, Trivy rescans the published Docker Hub image (amd64 and arm64) and reports findings in the repository's Security tab. The full CI (tests, `npm audit`, image build and scan) also runs weekly, so new advisories surface even without new commits. Socket scans every pull request and every push to `main`. [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/developingchet/zengate) grades the repository's security practices every week.
- Runtime dependencies are limited to Express and the official `@opencode/cli` package. The Docker image drops npm itself after installing them.

### Dependency alerts

Supply-chain scanners such as [Socket](https://socket.dev/npm/package/zengate) report capability alerts for zengate's dependency tree. These are expected and have been reviewed:

The capability explanations below do not dismiss vulnerability advisories. As of October 27, 2026, the CI-only Socket CLI 2.11.3 lock includes Brotli 1.2.0 and GitPython 3.2.0, with critical/high Dependabot alerts. That upstream release requires those exact versions, so a compatible patched upgrade is pending upstream. They are not npm runtime dependencies; a clean npm audit does not cover this Python tooling.

| Alert | Source | Why it is expected |
|---|---|---|
| Install scripts, native code, shell access | `@opencode/cli` and its `@opencode/cli-<platform>` packages | This is the official OpenCode CLI. Its install script selects the prebuilt binary for your platform, and zengate runs that binary as its isolated backend. |
| No license found, new author | `@opencode/cli-<platform>` binary packages | Published by the OpenCode maintainers without a license field in their `package.json`; only the one for your platform is installed. |
| Network, filesystem and environment access, URL strings | Express, `@opencode/cli` | Expected for an HTTP server and a CLI launcher. |
| Uses eval, dynamic require, debug access | `depd`, `debug` and similar Express internals | Long-standing Express dependencies. |
| Unmaintained | Small, finished Express helpers (for example `ee-first`, `escape-html`, `unpipe`) | Stable packages that have not needed changes in years; Express still depends on them. |

zengate removes what it can: CORS is handled in-house instead of by the `cors` package, and `overrides` replace polyfills in Express's tree with maintained `@socketregistry` packages when zengate is installed from source or run from the Docker image. If an alert looks new or out of place, please report it as described above.

## Hardening

See the [Security summary](README.md#security) in the README for the defaults and deployment advice.
