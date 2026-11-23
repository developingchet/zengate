# Support

## Before you ask

The [README](README.md) covers installation, a first start, client examples, the API surface, configuration
and troubleshooting. `GET /ready` and `GET /health` are the quickest local checks; the
[Troubleshooting](README.md#troubleshooting) table lists the error codes and their fixes. For a log that is
useful in a report, start the gateway with `LOG_LEVEL=debug`. Only the latest release receives security
fixes; see [SECURITY.md](SECURITY.md).

## Where to ask

| Question | Where |
|---|---|
| How to install, configure or use zengate | [Question form](https://github.com/developingchet/zengate/issues/new?template=question.yml) |
| Something does not work as documented | [Bug report form](https://github.com/developingchet/zengate/issues/new?template=bug_report.yml) |
| A new option, endpoint or improvement | [Feature request form](https://github.com/developingchet/zengate/issues/new?template=feature_request.yml) |
| A vulnerability in zengate | [Private vulnerability reporting](https://github.com/developingchet/zengate/security/advisories/new), as [SECURITY.md](SECURITY.md) describes. Never a public issue. |
| OpenCode, OpenCode Zen or model availability | [OpenCode issues](https://github.com/anomalyco/opencode/issues) upstream |
| A conduct concern | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), through its private reporting channel |

## What not to post

Before pasting logs or a request, remove API keys, backend passwords, request bodies and anything private.
Gateway errors and logs name attachment URLs by origin only, but a pasted request can still carry your own
data. Never post an unfixed vulnerability in someone else's project here. The aim is a small reproduction on
an install you own, not a dump of a production deployment.

Contributors and coding agents should also read [AGENTS.md](AGENTS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).
