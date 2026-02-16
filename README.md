# @silas/transport

> Generic WebSocket transport with injectable protocol schema, unified handler system, and Promise-based messaging.

Designed as the communication companion to `@silas/core` (state management). Both libraries work together but are fully decoupled — use either one independently.

- **Injectable protocol** — configure wire field names, codes, serialization, and ID generation. No built-in defaults — you define the entire schema.
- **Unified handlers** — persistent (server pushes) and ephemeral (request/response) in a single registry with automatic cleanup.
- **Three send modes** — `request()` (Promise), `fire()` (callback), `send()` (fire-and-forget).
- **Auto-reconnect** — configurable delay, max attempts, and backoff strategy.
- **Typed events** — lifecycle hooks via a typed event emitter instead of setter functions.

## Installation

```bash
npm install @silas/transport
```

## Quick Start

```ts
import { createTransport } from '@silas/transport';
import type { ProtocolSchema } from '@silas/transport';

const protocol: ProtocolSchema = {
  fields: {
    channel:     'action',
    messageId:   'reqId',
    type:        'type',
    code:        'status',
    description: 'desc',
    data:        'payload',
  },
  codes: { success: 'OK', interim: 'PENDING' },
  responseTypes: { NONE: 0, SILENT: 1, MESSAGE: 2, PROCESSING: 4, ALERT: 8, ALL: 15 },
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

## Send Modes

### `request()` — Promise-based

Resolves on success, rejects on failure or timeout. Interim responses are handled transparently.

```ts
try {
  const res = await transport.request(
    { channel: 'usuario', data: { id: 5 } },
    { timeout: 10_000 },
  );
  console.log(res.code); // 'OK'
  console.log(res.data); // server payload
} catch (err) {
  // err is the IncomingMessage on failure, or an Error on timeout
}
```

### `fire()` — Callback-based

Return `false` to keep listening (interim pattern).

```ts
const unsub = transport.fire(
  { channel: 'proceso', data: { id: 1 } },
  (msg) => {
    if (msg.code === protocol.codes.interim) {
      console.log('Still processing...');
      return false; // keep listening
    }
    console.log('Done:', msg.data);
    // returns void → auto-remove handler
  },
);

// Cancel early if needed
unsub();
```

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

Ephemeral handlers auto-remove when the callback returns `true` or `void`. Return `false` to keep alive (interim pattern).

## Protocol Schema

You must provide a complete `ProtocolSchema` when creating a transport. There are no built-in defaults.

```ts
import type { ProtocolSchema } from '@silas/transport';

const protocol: ProtocolSchema = {
  fields: {
    channel:     'action',     // wire field for the channel/operation name
    messageId:   'reqId',      // wire field for the unique message ID
    type:        'type',       // wire field for bitmask response type
    code:        'status',     // wire field for result code
    description: 'desc',       // wire field for human-readable description
    data:        'payload',    // wire field for data payload
  },
  codes: {
    success: 'OK',             // result code indicating success
    interim: 'PENDING',        // result code indicating interim/partial response
  },
  responseTypes: {
    NONE:       0,
    SILENT:     1,
    MESSAGE:    2,
    PROCESSING: 4,
    ALERT:      8,
    ALL:        15,
  },
  generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
  encode: (msg) => JSON.stringify(msg),
  decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  flattenOutgoing: true,       // true = flatten data onto root; false = nest under data field
};
```

### Wire Formats

**Outgoing (data flattened, `flattenOutgoing: true`)**:
```json
{ "action": "usuario", "reqId": 742381923, "id": 5, "nombre": "Ana" }
```

**Outgoing (data nested, `flattenOutgoing: false`)**:
```json
{ "action": "usuario", "reqId": 742381923, "payload": { "id": 5, "nombre": "Ana" } }
```

**Incoming**:
```json
{
  "action": "usuario",
  "reqId": 742381923,
  "type": 2,
  "status": "OK",
  "desc": "Success",
  "payload": { "usuario": [{ "id": 5, "nombre": "Ana" }] }
}
```

### Response Type Bitmask

| Flag | Value | Meaning |
|---|---|---|
| `NONE` | 0 | No match |
| `SILENT` | 1 | No visual action |
| `MESSAGE` | 2 | Show toast/snackbar |
| `PROCESSING` | 4 | Show/hide spinner |
| `ALERT` | 8 | Show modal |
| `ALL` | 15 | Match all types |

Access via `transport.protocol.responseTypes.MESSAGE`.

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
    auto: true,           // default: true
    delayMs: 10_000,      // default: 10s
    maxAttempts: Infinity, // default: Infinity
    backoff: 'fixed',     // 'fixed' | 'exponential' (default: 'fixed')
  },
});

// Disable reconnection
const transport2 = createTransport({
  url: 'wss://...',
  protocol,
  reconnect: false,
});
```

## Integration with @silas/core

The bridge lives in the consumer, not in either library:

```ts
import { createTransport } from '@silas/transport';
import { createStore, defineSchema } from '@silas/core/store';

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
  if (msg.code === protocol.codes.success && msg.data) {
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

## License

MIT © Silas
