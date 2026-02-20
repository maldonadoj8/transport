// =============================================================================
// @silas/transport — Main entry point
// =============================================================================

// Factory
export { createTransport } from './transport.js';

// Protocol
export { normalizeIncoming, buildOutgoing, resolveSchema } from './protocol.js';

// Events
export { createEmitter } from './events.js';
export type { Emitter } from './events.js';

// Handlers
export { createHandlerStore } from './handlers.js';
export type { HandlerStore } from './handlers.js';

// Types
export type {
  // Protocol
  ProtocolSchema,
  ResolvedProtocolSchema,
  ProtocolFields,
  ProtocolCodes,
  // Messages
  IncomingMessage,
  OutgoingMessage,
  // Handlers
  Handler,
  HandlerCallback,
  // Transport
  Transport,
  TransportOptions,
  TransportState,
  TransportEvents,
  TransportError,
  ReconnectOptions,
  RequestOptions,
  FireOptions,
} from './types.js';

// Convenience alias: typed emitter bound to TransportEvents.
import type { Emitter } from './events.js';
import type { TransportEvents } from './types.js';

/** A pre-bound Emitter type for transport lifecycle events. */
export type TransportEmitter = Emitter<TransportEvents>;
