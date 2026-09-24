# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are git tags, deployed with `task deploy TAG=<tag>`.

## [Unreleased]

### Added

- [PR-31](https://github.com/itk-dev/musikcsv/pull/31) -
  This changelog
- [PR-30](https://github.com/itk-dev/musikcsv/pull/30) -
  Deployment guide: config handling, deploying by tag, verifying and
  rolling back, and `.gitignore` covers backups of `config.js`
- [PR-28](https://github.com/itk-dev/musikcsv/pull/28) -
  `Taskfile.yml` with `install`, `dev`, `lint`, `test` and `deploy`, moving
  the deploy path into the repository, with a smoke test that fails on a
  cached answer
- [PR-27](https://github.com/itk-dev/musikcsv/pull/27) -
  Markdown and yaml linting from the shared ITK templates
- [PR-20](https://github.com/itk-dev/musikcsv/pull/20) -
  Opt-in push heartbeat to an Uptime Kuma monitor
- [PR-17](https://github.com/itk-dev/musikcsv/pull/17) -
  Logging of requests, errors, cache fallbacks and exit causes
- [PR-16](https://github.com/itk-dev/musikcsv/pull/16) -
  Local test stack with a seeded database, synthetic fixtures and smoke
  tests, run in CI against the production engine

### Changed

- [PR-29](https://github.com/itk-dev/musikcsv/pull/29) -
  Production, local development and CI run `node:24-slim` instead of the
  full image
- [PR-25](https://github.com/itk-dev/musikcsv/pull/25) -
  On the server, the node container runs as the deploy user (1042) instead
  of root
- [PR-23](https://github.com/itk-dev/musikcsv/pull/23) -
  Traefik routes straight to node, and the app trusts the forwarded headers
  it sets
- [PR-21](https://github.com/itk-dev/musikcsv/pull/21) -
  Upgraded to node 24 and mssql 11, and express to the latest 4.x

### Fixed

- [PR-22](https://github.com/itk-dev/musikcsv/pull/22) -
  One connection pool per named connection, so a route can no longer decide
  the database for every other route
- [PR-19](https://github.com/itk-dev/musikcsv/pull/19) -
  Decimal separator on negative amounts, which reached Excel as text instead
  of numbers
- [PR-18](https://github.com/itk-dev/musikcsv/pull/18) -
  The cached result is served when a query fails, not only when it returns
  no rows, and the cache is written atomically

### Removed

- [PR-24](https://github.com/itk-dev/musikcsv/pull/24) -
  Published container ports on the server, which made the app reachable
  bypassing Traefik
- [PR-23](https://github.com/itk-dev/musikcsv/pull/23) -
  nginx, whose cached upstream address could serve 502 indefinitely while
  looking healthy

[Unreleased]: https://github.com/itk-dev/musikcsv/compare/main...HEAD
