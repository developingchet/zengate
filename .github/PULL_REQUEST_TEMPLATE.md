## Summary

<!-- What does this change and why? Link the issue it closes. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature or API coverage
- [ ] Docs
- [ ] Refactor, tests or CI

## Testing

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Tested against real models with `npm run test:live` (if behaviour changed)
- [ ] `npm run test:leak` (if `@opencode/cli` or the OpenCode client changed; CI does not run it, and a new OpenCode 2 release could add a tool that skips the permission check)

Tests not run, and why:

## Compatibility

<!-- Does this change authentication, the managed backend's tool denial, the strict chat boundary, stored
responses, config defaults or what is logged? Say how an existing install is affected and how to roll back.
Write "none" if it does not. -->

## Checklist

- [ ] Tests added or updated for behaviour changes
- [ ] README and `CHANGELOG.md` (Unreleased) updated if needed
- [ ] `AGENTS.md` updated if a command, convention or security boundary changed
- [ ] No secrets, keys or private data in code, tests or logs
