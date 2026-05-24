# @silasdevs/transport

## 1.0.1

### Patch Changes

- [#5](https://github.com/maldonadoj8/transport/pull/5) [`97c8b4c`](https://github.com/maldonadoj8/transport/commit/97c8b4cc5e42966486b3698c252c44d2c1fece68) Thanks [@maldonadoj8](https://github.com/maldonadoj8)! - add per-call flattenOutgoing option for message handling

## 1.0.0

### Major Changes

- [#2](https://github.com/maldonadoj8/transport/pull/2) [`434a33d`](https://github.com/maldonadoj8/transport/commit/434a33d3128067d22873d1ffc54fa7904433c34b) Thanks [@maldonadoj8](https://github.com/maldonadoj8)! - **BREAKING**: `ProtocolFields.channel` split into `requestChannel` (outgoing) and `responseChannel` (incoming).

  **BREAKING**: `ProtocolFields.data` split into `payload` (outgoing) and `body` (incoming).

  **BREAKING**: `Emitter<TEvents>` and `createEmitter<TEvents>()` no longer have a default type parameter — callers must provide an explicit event map type.

  **Added**: `TransportError` interface — structured error object returned by `request()` on non-success responses, with `code`, `error`, `data`, and full `response` fields for programmatic error handling.

  **Added**: `TransportEmitter` type alias — convenience type for `Emitter<TransportEvents>`.

  **Changed**: `request()` now rejects with a `TransportError` object instead of the raw `IncomingMessage`.

  **BREAKING**: Package renamed from `@silas/transport` to `@silasdevs/transport`. Update all import paths and `package.json` dependencies accordingly.

## [Unreleased]

> Pending changes are tracked in `.changeset/`. Run `npm run version-packages` to apply them.

---

<!-- Pre-changeset history — kept for reference -->

## [0.0.1] - Initial release
