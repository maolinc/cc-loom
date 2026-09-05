# Open-source release checklist

Use this checklist before making the repository public or publishing packages.

## Repository identity

- [ ] Confirm the canonical GitHub `owner/repository`.
- [ ] Add `repository`, `homepage`, and `bugs` metadata to every published package.
- [ ] Confirm that the publisher owns the npm `@loom` scope, or replace it with an owned scope.
- [ ] Initialize or restore the real Git repository before the final tracked-file and history audit.

## Security and privacy

- [ ] Scan Git tracked files and the full Git history for secrets, credentials, private hosts, personal paths, and generated data.
- [ ] Confirm local-only files remain ignored: `.env*`, `.mcp.json`, `.claude/`, `.codex/`, `.scratch/`, databases, logs, coverage, test output, archives, and package tarballs.
- [ ] Rotate any credential that was ever committed, even if it was later removed.
- [ ] Enable GitHub private vulnerability reporting, secret scanning, push protection, and Dependabot alerts.
- [ ] Configure production `LOOM_ADMIN_EMAIL`, `LOOM_ADMIN_PASSWORD`, `LOOM_CORS_ORIGINS`, and secure-cookie behavior outside source control.

## Quality gates

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm audit --prod --audit-level=high`
- [ ] `just test-docker-l3`
- [ ] `just test-docker-l4`
- [ ] `just test-docker-l5`
- [ ] Inspect `pnpm pack --dry-run --json` for each published package.
- [ ] Review production dependency licenses.

## GitHub settings

- [ ] Require the CI workflow on the default branch.
- [ ] Protect the default branch and require review before merge.
- [ ] Restrict release and package-publish permissions to trusted maintainers.
- [ ] Verify issue forms, pull-request template, CodeQL, dependency review, and Dependabot are enabled.

## Release

- [ ] Replace placeholder repository links after the GitHub identity is known.
- [ ] Publish packages with npm provenance from a protected GitHub Actions environment.
- [ ] Create a signed or protected version tag and GitHub release from the reviewed commit.
- [ ] Re-run the smoke test using the published package, not the workspace build.
- [ ] Revisit ignored advisories when a compatible patched release becomes available.
