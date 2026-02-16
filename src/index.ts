// =============================================================================
// @silas/transport — Main entry point
// =============================================================================

// Factory
export { createTransport } from './transport.js';

// Protocol
export { normalizeIncoming, buildOutgoing } from './protocol.js';

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
  ProtocolFields,
  ProtocolCodes,
  ResponseTypes,
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
  ReconnectOptions,
  RequestOptions,
  FireOptions,
} from './types.js';
