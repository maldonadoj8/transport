# CHANGELOG

All notable changes to @silas/transport will be documented in this file.

## Legend

- **Added** - New features
- **Changed** - Changes to existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Security vulnerability fixes

---

## [Unreleased]

### Added
- `TransportError` interface — structured error object returned by `request()` on non-success responses, with `code`, `description`, `data`, and full `response` fields for programmatic error handling
- `TransportEmitter` type alias — convenience type for `Emitter<TransportEvents>`
- Six new error codes in `ProtocolCodes`: `error`, `validationError`, `unauthorized`, `notFound`, `timeout`, `rateLimited`

### Changed
- **BREAKING**: `ProtocolFields.channel` split into `requestChannel` (outgoing) and `responseChannel` (incoming)
- **BREAKING**: `ProtocolFields.data` split into `payload` (outgoing) and `body` (incoming)
- **BREAKING**: `ProtocolCodes` now requires all 8 code fields (was 2)
- **BREAKING**: `Emitter<TEvents>` and `createEmitter<TEvents>()` no longer have a default type parameter — callers must provide an explicit event map type
- `request()` now rejects with a `TransportError` object instead of the raw `IncomingMessage`

### Deprecated

### Removed

### Fixed

### Security

---

## [0.0.1] - YYYY-MM-DD

Initial release.

### Added

---

## Notes

- This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
- For planned features and improvements, see [TODO.md](TODO.md)

---

*Last Updated: 2026-02-16*