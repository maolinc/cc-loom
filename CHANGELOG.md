# Changelog

Notable user-facing changes will be recorded here.

## Unreleased

- Resolve the npm global `loom-server` symlink before main-module detection so
  the command starts correctly on Linux.
- Upgrade `better-sqlite3` to a Node 24-compatible release so the server can
  install without a local C/C++ build toolchain on supported platforms.
- Prepare the repository and npm packages for their first public release.
- Require an explicitly configured bootstrap administrator and stronger
  passwords; transparently migrate legacy password hashes after login.
- Restrict Marketplace administration and reject unsafe repository targets.
- Add browser-origin checks, request rate limits, security headers, and a
  non-root production container process.
