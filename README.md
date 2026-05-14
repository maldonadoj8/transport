# @silasdevs/transport

> Generic WebSocket transport with injectable protocol schema, unified handler system, and Promise-based messaging.

Designed as the communication companion to `@silasdevs/core` (state management). Both libraries work together but are fully decoupled — use either one independently.

- **Injectable protocol** — configure wire field names, codes, serialization, and ID generation. No built-in defaults — you define the entire schema.
- **Channel-optional** — protocols that use named channels (like internal APIs) and channel-less protocols (like WhiteBit, Binance) both work out of the box.
- **Unified handlers** — persistent (server pushes) and ephemeral (request/response) in a single registry with automatic cleanup.
- **ID-based routing** — responses are matched to requests by message ID, with a secondary index fallback for protocols that omit channel fields in responses.
- **Three send modes** — `request()` (Promise), `fire()` (callback), `send()` (fire-and-forget).
- **Auto-reconnect** — configurable delay, max attempts, and backoff strategy.
- **Typed events** — lifecycle hooks via a typed event emitter instead of setter functions.

## Installation

```bash
npm install @silasdevs/transport
```

## Quick Start

```ts
import { createTransport } from '@silasdevs/transport';
import type { ProtocolSchema } from '@silasdevs/transport';

const protocol: ProtocolSchema = {
  fields: {
    requestChannel:  'action',   // wire field for channel on outgoing messages
    responseChannel: 'action',   // wire field for channel on incoming messages
    messageId:       'reqId',    // wire field for the unique message ID
    code:            'status',   // wire field for result code
    description:     'desc',     // wire field for human-readable description
    payload:         'payload',  // wire field for data on outgoing messages
    body:            'payload',  // wire field for data on incoming messages
  },
  codes: {
    success: 'OK',
    interim: 'PENDING',
    error:   ['FAIL'],
  },
  generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
  encode: (msg) => JSON.stringify(msg),
  decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  flattenOutgoing: true,
};

const transport = createTransport({
  url: 'wss://api.example.com/websocket',
  protocol,
});

transport.connect();

// Promise-based request
const res = await transport.request({
  channel: 'usuario',
  data: { id: 5 },
});
console.log(res.data); // { usuario: [{ id: 5, nombre: 'Ana' }] }

// Persistent handler for server pushes
transport.addHandler('entrega', 'sync', (msg) => {
  console.log('Delivery update:', msg.data);
});
```

## Channel-less Protocols

Not all WebSocket APIs use channel fields. For protocols like WhiteBit or Binance where routing is done purely by message ID, simply omit `requestChannel` and `responseChannel`:

```ts
const whitebitProtocol: ProtocolSchema = {
  fields: {
    // No requestChannel or responseChannel — routing is ID-based only.
    messageId:   'id',
    code:        'status',     // not used by WhiteBit, but required field
    description: 'error',
    payload:     'params',
    body:        'result',
  },
  // No codes — all responses are treated as success.
  generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
  encode: (msg) => JSON.stringify(msg),
  decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  flattenOutgoing: false,
  includeIdInRequest: true,    // WhiteBit expects the ID on the wire
};

const transport = createTransport({
  url: 'wss://api.whitebit.com/ws',
  protocol: whitebitProtocol,
});

transport.connect();

// No channel needed — just send data
const res = await transport.request({
  data: { method: 'server.ping', params: [] },
});
console.log(res.data); // { result: 'pong' }
```

Internally, channel-less messages use the wildcard `'*'` for handler routing. You can register persistent handlers on `'*'` to receive spontaneous server pushes:

```ts
transport.addHandler('*', 'push-listener', (msg) => {
  console.log('Server push:', msg.data);
});
```

## Send Modes

### `request()` — Promise-based

Resolves on success, rejects on failure or timeout. Interim responses are handled transparently.

```ts
import type { TransportError } from '@silasdevs/transport';

try {
  const res = await transport.request(
    { channel: 'usuario', data: { id: 5 } },
    { timeout: 10_000 },
  );
  console.log(res.code); // 'OK'
  console.log(res.data); // server payload
} catch (err) {
  if (err instanceof Error) {
    // Timeout or network error (plain Error).
    console.error('Timeout or connection error:', err.message);
  } else {
    // Protocol-level failure — TransportError shape.
    const e = err as TransportError;
    console.error('Protocol error:', e.code, e.error, e.data);
  }
}
```

**Timeout behaviour:**
- `timeout` defaults to `30_000` ms.
- Pass `timeout: 0` to disable the timeout entirely (request waits indefinitely).
- Interim responses (`codes.interim`) do **not** reset the timer. The clock starts when `request()` is called and the same deadline applies throughout.
- On timeout the promise rejects with a plain `Error` (not a `TransportError`), so `err instanceof Error` reliably identifies timeouts.
- If `disconnect()` is called while a request is pending the promise rejects when the timeout fires (no early rejection).

### `fire()` — Callback-based

Return `false` to keep the handler alive (interim pattern). The callback receives **every** message including interim ones — unlike `request()` it does not skip them.

```ts
const unsub = transport.fire(
  { channel: 'proceso', data: { id: 1 } },
  (msg) => {
    if (msg.code === 'PENDING') {
      console.log('Still processing...', msg.data);
      return false; // keep listening — handler stays registered
    }
    console.log('Done:', msg.data);
    // return void/true → auto-remove handler
  },
);

// Cancel early if needed
unsub();
```

> **Note:** `fire()` has no built-in timeout. Use the returned `unsub()` to cancel if necessary.

### `send()` — Fire-and-forget

```ts
transport.send({ channel: 'ping' });
```

## Handlers

Two types, one registry:

| Type | Key | Lifetime | Use case |
|---|---|---|---|
| **persistent** | string name | Until explicitly removed | Server pushes, entity sync |
| **ephemeral** | numeric messageId | Auto-removed on definitive response | Request/response pairs |

```ts
// Persistent — receives all 'entrega' pushes (messageId=0)
const unsub = transport.addHandler('entrega', 'my-sync', (msg) => {
  console.log('Push:', msg.data);
});
unsub(); // or transport.removeHandler('entrega', 'my-sync')

// Ephemeral — created automatically by request() and fire()
```

Ephemeral handlers auto-remove when the callback returns anything other than exactly `false` (including `void`, `true`, `null`, `0`, `""`). Return `false` to keep alive (interim pattern).

**Handler execution order:** persistent handlers execute in the order they were registered. Ephemeral handlers take priority over persistent handlers for the same (channel, messageId) pair.

### Handler Routing

Messages are routed through a 4-step priority chain:

1. **Ephemeral by (channel, messageId)** — exact match for request/response pairs
2. **Persistent by channel** — all matching handlers execute
3. **ID-only fallback** — if the message has a `messageId` but no matching channel, a secondary index resolves the original channel (useful when responses omit the channel field)
4. **Unhandled** — emits `message:unhandled` event

## Protocol Schema

You must provide a `ProtocolSchema` when creating a transport. There are no built-in defaults.

### `ProtocolFields`

Maps canonical field names to actual wire field names:

| Field | Required | Description |
|---|---|---|
| `requestChannel` | No | Wire field for channel on outgoing messages. Omit for channel-less protocols. |
| `responseChannel` | No | Wire field for channel on incoming messages. Omit for channel-less protocols. |
| `subscriptionChannel` | No | Fallback channel field for subscription/event messages (e.g. Binance `"e"`). |
| `messageId` | Yes | Wire field for the unique message ID. |
| `code` | Yes | Wire field for the result code. |
| `description` | Yes | Wire field for human-readable description. |
| `payload` | Yes | Wire field for data on outgoing messages. |
| `body` | Yes | Wire field for data on incoming messages. |

### `ProtocolCodes`

All fields are optional. When the entire `codes` object is omitted, all responses resolve immediately:

| Field | Type | Description |
|---|---|---|
| `success` | `string` | Value indicating success. When undefined, all non-interim/non-error responses succeed. |
| `interim` | `string` | Value indicating an interim/partial response (keep listening). |
| `error` | `string[]` | Value(s) indicating an error. Multiple codes supported. |

### `ProtocolSchema`

| Field | Required | Description |
|---|---|---|
| `fields` | Yes | Maps canonical field names to wire field names. |
| `codes` | No | Special result code values for classification. |
| `generateId` | Yes | Function that generates a unique numeric message ID. |
| `encode` | Yes | Serialize a message object to a string for the wire. |
| `decode` | Yes | Deserialize a raw wire string to an object (return `null` on failure). |
| `flattenOutgoing` | Yes | `true` = spread data onto root; `false` = nest under payload field. |
| `includeIdInRequest` | No | `true` = include messageId on the wire; `false` (default) = ID used internally only. |

### Example: Channel-based Protocol

```ts
const protocol: ProtocolSchema = {
  fields: {
    requestChannel:  'action',
    responseChannel: 'action',
    messageId:       'reqId',
    code:            'status',
    description:     'desc',
    payload:         'payload',
    body:            'payload',
  },
  codes: {
    success: 'OK',
    interim: 'PENDING',
    error:   ['ERROR'],
  },
  generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
  encode: (msg) => JSON.stringify(msg),
  decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  flattenOutgoing: true,
};
```

### Example: Channel-less Protocol (WhiteBit-style)

```ts
const protocol: ProtocolSchema = {
  fields: {
    messageId:   'id',
    code:        'status',
    description: 'error',
    payload:     'params',
    body:        'result',
  },
  generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
  encode: (msg) => JSON.stringify(msg),
  decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  flattenOutgoing: false,
  includeIdInRequest: true,
};
```

### Wire Formats

**Outgoing (channel-based, data flattened)**:
```json
{ "action": "usuario", "reqId": 742381923, "id": 5, "nombre": "Ana" }
```

**Outgoing (channel-based, data nested)**:
```json
{ "action": "usuario", "reqId": 742381923, "payload": { "id": 5, "nombre": "Ana" } }
```

**Outgoing (channel-less)**:
```json
{ "id": 742381923, "params": { "method": "server.ping" } }
```

**Incoming (channel-based)**:
```json
{
  "action": "usuario",
  "reqId": 742381923,
  "status": "OK",
  "desc": "Success",
  "payload": { "usuario": [{ "id": 5, "nombre": "Ana" }] }
}
```

**Incoming (channel-less)**:
```json
{ "id": 742381923, "result": { "pong": true } }
```

## Events

Typed lifecycle events:

```ts
transport.on('connected', (evt) => console.log('Connected'));
transport.on('disconnected', ({ code, reason }) => console.log('Disconnected:', code));
transport.on('reconnecting', ({ attempt, delayMs }) => console.log(`Retry #${attempt}`));
transport.on('error', (evt) => console.error('WS error'));

transport.on('message:raw', ({ data }) => console.log('Raw:', data));
transport.on('message:parsed', (msg) => console.log('Parsed:', msg.channel));
transport.on('message:unhandled', (msg) => console.log('Unhandled:', msg.channel));

transport.on('send:before', ({ payload }) => console.log('Sending:', payload));
transport.on('send:after', ({ payload }) => console.log('Sent:', payload));
transport.on('send:error', ({ reason }) => console.error('Send failed:', reason));

// All .on() calls return an unsubscribe function
const unsub = transport.on('connected', handler);
unsub();
```

## Reconnection

```ts
const transport = createTransport({
  url: 'wss://api.example.com/ws',
  protocol,
  reconnect: {
    auto: true,            // default: true
    delayMs: 10_000,       // default: 10s
    maxAttempts: Infinity, // default: Infinity
    backoff: 'fixed',      // 'fixed' | 'exponential' (default: 'fixed')
  },
});

// Disable reconnection
const transport2 = createTransport({
  url: 'wss://...',
  protocol,
  reconnect: false,
});
```

**Backoff strategies:**
- `'fixed'` — waits exactly `delayMs` between every attempt.
- `'exponential'` — delay doubles each attempt: `delayMs × 2^attempt`, capped at **60 seconds**.
  - Example with `delayMs: 1000`: 1 s → 2 s → 4 s → 8 s → … → 60 s

**`disconnect({ clean: true })`** — setting `clean: true` additionally clears all stale ephemeral handlers (request/response pairs that will never resolve). Without `clean`, persistent handlers remain registered.

**Reconnect on send failure:** if `send()` is called while the socket is closed or closing and `reconnect.auto` is `true`, a reconnect attempt is scheduled with a 1 s delay.

## Debug Logging

Pass `debug: true` to enable console logging for all connection lifecycle events, sends, receives, and handler routing:

```ts
const transport = createTransport({
  url: 'wss://api.example.com/ws',
  protocol,
  debug: true, // logs to console.log with '[silas/transport]' prefix
});

// Toggle at runtime
transport.debug(true);
transport.debug(false);
```

Logged events include: connecting, connected, disconnected, reconnecting, send (before/after/error), message received, message decoded, handler matched/unmatched.

## Channel-less Protocol Gotcha

If your protocol has no `responseChannel` defined, incoming messages always resolve to channel `'*'`. Persistent handlers registered on a **named** channel will **never** fire for those messages:

```ts
// ❌ Will never fire — no responseChannel means all messages arrive on '*'.
transport.addHandler('priceUpdate', 'prices', (msg) => { /* ... */ });

// ✅ Register on '*' to receive all channel-less pushes.
transport.addHandler('*', 'prices', (msg) => { /* ... */ });
```

## Integration with @silasdevs/core

The bridge lives in the consumer, not in either library:

```ts
import { createTransport } from '@silasdevs/transport';
import { createStore, defineSchema } from '@silasdevs/core/store';

const store = createStore({
  schema: defineSchema({
    tables: {
      usuario: { key: 'id', version: 'version' },
      entrega: { key: 'id', version: 'version' },
    },
  }),
});

const transport = createTransport({
  url: 'wss://api.example.com/ws',
  protocol,
});

// Bridge: classify incoming data into the store
transport.on('message:parsed', (msg) => {
  if (msg.data) {
    store.classify(msg.data);
  }
});

transport.connect();
```

## API Reference

### Factory

| Export | Description |
|---|---|
| `createTransport(opts)` | Create a Transport instance |

### Transport Instance

| Method | Description |
|---|---|
| `connect()` | Open WebSocket (idempotent) |
| `disconnect({ clean? })` | Close WebSocket |
| `request(msg, opts?)` | Promise-based send |
| `fire(msg, cb, opts?)` | Callback-based send |
| `send(msg)` | Fire-and-forget send |
| `addHandler(channel, name, cb)` | Register persistent handler |
| `removeHandler(channel, name)` | Remove persistent handler |
| `on(event, cb)` | Subscribe to lifecycle event |
| `once(event, cb)` | Subscribe once |
| `debug(enabled)` | Toggle debug logging |
| `destroy()` | Disconnect + cleanup everything |
| `state` | Current `TransportState` (readonly) |
| `protocol` | Resolved `ProtocolSchema` (readonly) |

### Protocol

| Export | Description |
|---|---|
| `normalizeIncoming(raw, schema)` | Wire → `IncomingMessage` |
| `buildOutgoing(msg, id, schema)` | `OutgoingMessage` → wire |

### Utilities

| Export | Description |
|---|---|
| `createEmitter<T>()` | Typed event emitter factory |
| `createHandlerStore()` | Handler registry factory |

### Types

All types are exported for consumers:

```ts
import type {
  ProtocolSchema,
  ProtocolFields,
  ProtocolCodes,
  IncomingMessage,
  OutgoingMessage,
  Handler,
  HandlerCallback,
  Transport,
  TransportOptions,
  TransportState,
  TransportEvents,
  TransportError,
  TransportEmitter,
  ReconnectOptions,
  RequestOptions,
  FireOptions,
} from '@silasdevs/transport';
```

## License

MIT © Silas
