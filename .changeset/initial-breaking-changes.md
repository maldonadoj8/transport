---
"@silasdevs/transport": major
---

**BREAKING**: `ProtocolFields.channel` split into `requestChannel` (outgoing) and `responseChannel` (incoming).

**BREAKING**: `ProtocolFields.data` split into `payload` (outgoing) and `body` (incoming).

**BREAKING**: `Emitter<TEvents>` and `createEmitter<TEvents>()` no longer have a default type parameter — callers must provide an explicit event map type.

**Added**: `TransportError` interface — structured error object returned by `request()` on non-success responses, with `code`, `error`, `data`, and full `response` fields for programmatic error handling.

**Added**: `TransportEmitter` type alias — convenience type for `Emitter<TransportEvents>`.

**Changed**: `request()` now rejects with a `TransportError` object instead of the raw `IncomingMessage`.

**BREAKING**: Package renamed from `@silas/transport` to `@silasdevs/transport`. Update all import paths and `package.json` dependencies accordingly.
