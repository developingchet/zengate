# Contributing

Thanks for helping improve zengate. Bug reports, fixes and docs improvements are all welcome.

## Before you start

- For a bug, open an issue with the version, how you run it and the steps to reproduce.
- For a larger change or a new feature, open an issue first so we can agree on the approach.
- For a security problem, **do not open an issue**. Follow [SECURITY.md](SECURITY.md) instead.

## Development setup

Requires Node.js 24+.

```bash
git clone https://github.com/developingchet/zengate.git
cd zengate
npm ci
npm start          # creates config.json with a key on first start
```

Checks (CI runs the same ones on Linux, Windows and macOS):

```bash
npm run lint       # syntax, file size and hygiene checks
npm test           # unit + integration tests against a fake OpenCode server
npm run test:coverage
npm run audit
```

`npm run test:live` runs an end-to-end check against real Zen models through a running gateway (`GATEWAY_URL` and `API_KEY` must be set). It is not part of CI.

## Guidelines

- Keep the design goals in mind: easy to set up, secure by default, fast, and faithful to the OpenAI API.
- Never add code that imitates OpenCode or bypasses Zen's free-tier checks. zengate only talks to Zen through the real OpenCode CLI.
- Add or update tests with every behaviour change. Tests go in `test/` and use `node:test`.
- Keep files focused and under 800 lines, and functions small.
- Validate input at the boundary and return errors in the OpenAI error format.
- Never log request bodies or keys.
- Update the README and `CHANGELOG.md` (under **Unreleased**) when behaviour or configuration changes.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`, `ci:`.
- Keep pull requests focused on one change, fill in the template, and make sure CI is green.

## Releasing (maintainers)

1. Move the **Unreleased** notes in `CHANGELOG.md` under the new version and date.
2. Bump the version: `npm version <patch|minor|major> --no-git-tag-version`, then commit (`chore: release vX.Y.Z`) and merge to `main`.
3. Tag the merged commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The `release` workflow then checks that the tag matches `package.json`, runs the tests, publishes the Docker image (amd64 + arm64, scanned, signed, with an SBOM), publishes to npm with provenance, and creates the GitHub release. A tag with a suffix such as `v1.3.0-rc.1` is published as a pre-release (npm tag `next`, no `latest` Docker tag).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
