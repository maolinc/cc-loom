# Contributing to Loom

Thanks for helping improve Loom. Keep changes focused, preserve existing user
data and configuration fields, and add tests at the layer that observes the
real behavior being changed.

## Development setup

Requirements: Node.js 20 or newer, pnpm 11, and Docker for L3-L5 tests.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Read `product-functional-doc.md` before changing product behavior,
`docs/code-guide/README.md` before changing structure or data flow, and
`docs/testing/principles.md` before adding or modifying tests.

## Pull requests

- Explain the problem, the chosen approach, and the user-visible effect.
- Keep unrelated refactors out of the same change.
- Add a regression test for bug fixes and verify it fails before the fix.
- Run L1 tests locally. Run non-unit tests through the repository's Docker
  test runtime (`just test-docker-all`).
- Never commit credentials, local Agent configuration, generated databases,
  build artifacts, or private URLs.

By contributing, you agree that your contribution is licensed under the MIT
License included in this repository.
