// =============================================================================
// @silas/transport — Public Types
//
// All type definitions for the transport layer. No runtime code here.
// =============================================================================

// ======================== PROTOCOL SCHEMA ====================================

/** Maps protocol field names to the actual wire field names. */
export interface ProtocolFields {
  /** Wire field name for the channel on outgoing (request) messages. */
  requestChannel: string;
  /** Wire field name for the channel on incoming (response) messages. */
  responseChannel: string;
  /** Field name for the unique message ID. */
  messageId: string;
  /** Field name for the bitmask response type. */
  type: string;
  /** Field name for the result code. */
  code: string;
  /** Field name for the human-readable description. */
  description: string;
  /** Wire field name for the data on outgoing (request) messages. */
  payload: string;
  /** Wire field name for the data on incoming (response) messages. */
  body: string;
}

/** Result code values that have special meaning in the protocol. */
export interface ProtocolCodes {
  /** Value indicating success. */
  success: string;
  /** Value indicating an interim/partial response. */
  interim: string;
  /** Value indicating a generic error. */
  error: string;
  /** Value indicating a validation failure. */
  validationError: string;
  /** Value indicating an authentication/authorization failure. */
  unauthorized: string;
  /** Value indicating a resource was not found. */
  notFound: string;
  /** Value indicating a server-side timeout. */
  timeout: string;
  /** Value indicating a rate limit was exceeded. */
  rateLimited: string;
}

/** Bitmask flags for response type routing. */
export interface ResponseTypes {
  /** No match / break (0). */
  none: number;
  /** No visual action (1). */
  silent: number;
  /** Show toast/snackbar (2). */
  message: number;
  /** Show/hide loading spinner (4). */
  processing: number;
  /** Show modal/alert (8). */
  alert: number;
  /** Match everything (15). */
  all: number;
}

/**
 * Structured error returned when `request()` rejects due to a non-success response.
 * Allows consumers to programmatically branch on the error code.
 */
export interface TransportError {
  /** The protocol result code (e.g. the value from `ProtocolCodes.error`). */
  code: string;
  /** Human-readable description from the server. */
  description: string;
  /** Response data payload. */
  data: Record<string, unknown>;
  /** The full normalized incoming message for advanced inspection. */
  response: IncomingMessage;
}

/**
 * Injectable protocol schema that describes the wire format.
 * All properties must be provided — there are no defaults.
 */
export interface ProtocolSchema {
  /** Maps canonical field names to wire field names. */
  fields: ProtocolFields;
  /** Special result code values. */
  codes: ProtocolCodes;
  /** Bitmask response type flags. */
  responseTypes: ResponseTypes;
  /** Generate a unique message ID. */
  generateId: () => number;
  /** Serialize a message for the wire. */
  encode: (message: Record<string, unknown>) => string;
  /** Deserialize a raw wire message. */
  decode: (raw: string) => Record<string, unknown> | null;
  /**
   * Whether outgoing `data` fields are flattened onto the root message object.
   * When true, `{ channel: 'x', data: { a: 1 } }` becomes `{ action: 'x', a: 1 }`.
   * When false, data is nested under the payload field name.
   */
  flattenOutgoing: boolean;
}

// ======================== MESSAGES ===========================================

/** A normalized incoming message (protocol-agnostic shape). */
export interface IncomingMessage {
  /** The API channel / operation name. */
  channel: string;
  /** The unique message ID (0 = spontaneous server push). */
  messageId: number;
  /** Bitmask response type. */
  type: number;
  /** Result code (e.g. success, interim, or error codes). */
  code: string;
  /** Human-readable description. */
  description: string;
  /** Response data payload. */
  data: Record<string, unknown>;
  /** The original un-normalized wire message. */
  raw: Record<string, unknown>;
}

/** Outgoing message to send over the transport. */
export interface OutgoingMessage {
  /** The API channel / operation name. */
  channel: string;
  /** Optional data payload. */
  data?: Record<string, unknown>;
}

// ======================== HANDLERS ===========================================

/** Callback for handling an incoming message. */
export type HandlerCallback = (message: IncomingMessage) => boolean | void;

/**
 * Unified handler that replaces the separate HANDLERS (persistent) and
 * MANEJADORES (ephemeral) systems.
 *
 * - persistent: stays registered until explicitly removed. Used for
 *   spontaneous server pushes (like entity change notifications).
 * - ephemeral: auto-removed after handling one definitive response.
 *   Returns false to stay alive (interim pattern).
 */
export interface Handler {
  type: 'persistent' | 'ephemeral';
  callback: HandlerCallback;
  /** Name key for persistent handlers (for deduplication/removal). */
  name?: string;
}

// ======================== TRANSPORT OPTIONS ===================================

/** Reconnection configuration. */
export interface ReconnectOptions {
  /** Enable auto-reconnection (default: true). */
  auto?: boolean;
  /** Delay in ms before reconnecting (default: 10_000). */
  delayMs?: number;
  /** Maximum reconnection attempts (default: Infinity). */
  maxAttempts?: number;
  /** Backoff strategy (default: 'fixed'). */
  backoff?: 'fixed' | 'exponential';
}

/** Options for request() — Promise-based send with response. */
export interface RequestOptions {
  /** Timeout in ms. 0 = no timeout (default: 30_000). */
  timeout?: number;
  /** Bitmask filter — which response types to obey (default: ALL = 15). */
  obey?: number;
}

/** Options for fire() — callback-based send. */
export interface FireOptions {
  /** Bitmask filter (default: ALL = 15). */
  obey?: number;
}

/**
 * Connection state of the transport.
 *
 * - disconnected: no active connection
 * - connecting: WebSocket is opening
 * - connected: WebSocket is open and ready
 * - reconnecting: attempting to re-establish after a drop
 */
export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

/** Configuration for createTransport(). */
export interface TransportOptions {
  /** WebSocket URL. Can be a string or a function for lazy evaluation. */
  url: string | (() => string);
  /** Complete protocol schema describing the wire format. Required. */
  protocol: ProtocolSchema;
  /** Reconnection config. Pass false to disable. */
  reconnect?: ReconnectOptions | false;
  /** Enable debug logging (default: false). */
  debug?: boolean;
}



// ======================== EVENTS =============================================

/** Map of transport lifecycle events and their payloads. */
export interface TransportEvents {
  /** WebSocket is opening. */
  connecting: undefined;
  /** WebSocket is open and ready. */
  connected: Event;
  /** WebSocket has closed. */
  disconnected: { code?: number; reason?: string; wasClean?: boolean };
  /** Attempting auto-reconnection. */
  reconnecting: { attempt: number; delayMs: number };
  /** WebSocket error. */
  error: Event;
  /** Raw message received (before parsing). */
  'message:raw': { data: string };
  /** Parsed and normalized message. */
  'message:parsed': IncomingMessage;
  /** No handler matched for this message. */
  'message:unhandled': IncomingMessage;
  /** About to send a message. */
  'send:before': { payload: Record<string, unknown> };
  /** Message sent successfully. */
  'send:after': { payload: Record<string, unknown> };
  /** Failed to send (socket not open). */
  'send:error': { payload: Record<string, unknown>; reason: string };
}

// ======================== TRANSPORT INSTANCE ==================================

/** The public API of a Transport instance created by createTransport(). */
export interface Transport {
  /** Open the WebSocket connection. Idempotent. */
  connect(): void;
  /** Close the WebSocket connection. */
  disconnect(options?: { clean?: boolean }): void;
  /** Current connection state. */
  readonly state: TransportState;

  /**
   * Fire-and-forget send.
   * Use request() for Promise-based responses or fire() for callbacks.
   */
  send(msg: OutgoingMessage): void;

  /**
   * Promise-based send. Resolves on success, rejects on failure or timeout.
   * Handles NEUTRO interim responses transparently.
   */
  request(msg: OutgoingMessage, options?: RequestOptions): Promise<IncomingMessage>;

  /**
   * Callback-based send.
   * The callback receives each response. Return false to keep listening (NEUTRO).
   * Returns an unsubscribe function.
   */
  fire(
    msg: OutgoingMessage,
    callback: HandlerCallback,
    options?: FireOptions,
  ): () => void;

  /** Register a persistent handler. Returns unsubscribe function. */
  addHandler(channel: string, name: string, callback: HandlerCallback): () => void;
  /** Remove a persistent handler by name. */
  removeHandler(channel: string, name: string): boolean;

  /** Subscribe to lifecycle events. Returns unsubscribe function. */
  on<K extends keyof TransportEvents>(
    event: K,
    callback: (data: TransportEvents[K]) => void,
  ): () => void;
  /** Subscribe to a lifecycle event once. Returns unsubscribe function. */
  once<K extends keyof TransportEvents>(
    event: K,
    callback: (data: TransportEvents[K]) => void,
  ): () => void;

  /** The resolved protocol schema (readonly). */
  readonly protocol: ProtocolSchema;
  /** Toggle debug logging. */
  debug(enabled: boolean): void;
  /** Disconnect, clear all handlers, remove all listeners. */
  destroy(): void;
}
