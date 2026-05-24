// =============================================================================
// @silas/transport — Public Types
//
// All type definitions for the transport layer. No runtime code here.
// =============================================================================

// ======================== PROTOCOL SCHEMA ====================================

/** Maps protocol field names to the actual wire field names. All fields are optional. */
export interface ProtocolFields {
  /**
   * Wire field name for the channel on outgoing (request) messages.
   * When omitted, outgoing messages carry no channel field and the
   * wildcard `'*'` is used internally for handler routing.
   */
  requestChannel?: string;
  /**
   * Wire field name for the channel on incoming (response) messages.
   * When omitted, incoming messages resolve their channel via
   * `subscriptionChannel` or fall back to the wildcard `'*'`.
   */
  responseChannel?: string;
  /**
   * Wire field name for the channel on subscription/event messages.
   * Used as a fallback when `responseChannel` yields no value.
   * Useful when event messages arrive on a different field than responses
   * (e.g. Binance uses `"e"` for event type).
   */
  subscriptionChannel?: string;
  /** Field name for the unique message ID. When omitted, defaults to 0. */
  messageId?: string;
  /** Field name for the result code. When omitted, defaults to ''. */
  code?: string;
  /** Field name for the human-readable description. When omitted, defaults to ''. */
  description?: string;
  /**
   * Wire field name for the error value in the raw response message.
   * When omitted, `IncomingMessage.error` is `undefined`.
   * Can be any shape — string, object, etc.
   */
  error?: string;
  /** Wire field name for the data on outgoing (request) messages. When omitted, data is not nested. */
  payload?: string;
  /** Wire field name for the data on incoming (response) messages. When omitted, defaults to {}. */
  body?: string;
  /**
   * Wire field name for the data payload in subscription/event messages.
   * Falls back to `body` when omitted.
   * Useful when event messages carry data in a different field than responses
   * (e.g. WhiteBit uses `"result"` for responses and `"params"` for events).
   */
  eventBody?: string;
}

/**
 * Result code values that have special meaning in the protocol.
 *
 * All fields are optional:
 * - When `success` is undefined, every non-interim, non-error response is
 *   treated as success.
 * - When `error` is undefined, no responses are treated as errors (unless
 *   they fail the success check when success IS defined).
 * - When `interim` is undefined, no responses are treated as interim.
 * - When the entire `codes` object is omitted from the schema, all responses
 *   resolve immediately.
 */
export interface ProtocolCodes {
  /** Value indicating success. When undefined, all non-interim/non-error responses succeed. */
  success?: string;
  /** Value indicating an interim/partial response (keep listening). */
  interim?: string;
  /** Value(s) indicating an error. Multiple codes can be provided. */
  error?: string[];
}

/**
 * Structured error returned when `request()` rejects due to a non-success response.
 * Allows consumers to programmatically branch on the error code.
 */
export interface TransportError<E = unknown> {
  /** The protocol result code (e.g. the value from `ProtocolCodes.error`). */
  code: string;
  /** Error value extracted from the response via `ProtocolFields.error`. */
  error: E;
  /** Response data payload. */
  data: Record<string, unknown>;
  /** The full normalized incoming message for advanced inspection. */
  response: IncomingMessage<Record<string, unknown>, E>;
}

/**
 * Injectable protocol schema that describes the wire format.
 * All properties are optional and have sensible defaults.
 */
export interface ProtocolSchema {
  /** Maps canonical field names to wire field names. Defaults to `{}`. */
  fields?: ProtocolFields;
  /**
   * Special result code values. When omitted, all responses are treated
   * as successful (no interim or error classification).
   */
  codes?: ProtocolCodes;
  /**
   * Generate a unique message ID.
   * Default: `crypto.getRandomValues` for a cryptographically random 32-bit unsigned integer.
   */
  generateId?: () => number;
  /**
   * Serialize a message for the wire.
   * Default: `JSON.stringify`.
   */
  encode?: (message: Record<string, unknown>) => string;
  /**
   * Deserialize a raw wire message.
   * Default: `JSON.parse` (returns `null` on failure).
   */
  decode?: (raw: string) => Record<string, unknown> | null;
  /**
   * Whether outgoing `data` fields are flattened onto the root message object.
   * When true, `{ channel: 'x', data: { a: 1 } }` becomes `{ action: 'x', a: 1 }`.
   * Default: `false`.
   */
  flattenOutgoing?: boolean;
  /**
   * Whether to include the generated message ID in outgoing request messages.
   * When true, the `messageId` field is added to the wire message built by
   * `buildOutgoing`. When false (default), the ID is used only internally for
   * request/response linking and is not sent on the wire.
   */
  includeIdInRequest?: boolean;
}

/**
 * Fully resolved protocol schema with all defaults applied.
 * This is the internal type used throughout the library after calling `resolveSchema()`.
 */
export interface ResolvedProtocolSchema {
  fields: ProtocolFields;
  codes?: ProtocolCodes;
  generateId: () => number;
  encode: (message: Record<string, unknown>) => string;
  decode: (raw: string) => Record<string, unknown> | null;
  flattenOutgoing: boolean;
  includeIdInRequest: boolean;
}

// ======================== MESSAGES ===========================================

/** A normalized incoming message (protocol-agnostic shape). 
*/
export interface IncomingMessage<BData = Record<string, unknown>, E = unknown> {
  /** The API channel / operation name. */
  channel: string;
  /** The unique message ID (0 = spontaneous server push). */
  messageId: number;
  /** Result code (e.g. success, interim, or error codes). */
  code: string;
  /** Human-readable description. */
  description: string;
  /** Error value extracted from the response via `ProtocolFields.error`. */
  error: E;
  /** Response data payload. */
  data: BData;
  /** The original un-normalized wire message. */
  raw: Record<string, unknown>;
}

/** Outgoing message to send over the transport. */
export interface OutgoingMessage<PData = Record<string, unknown>> {
  /**
   * The API channel / operation name.
   * Optional when the protocol has no `requestChannel` defined — in that
   * case the wildcard `'*'` is used for internal handler routing.
   */
  channel?: string;
  /** Optional data payload. */
  data?: PData;
}

// ======================== HANDLERS ===========================================

/** Callback for handling an incoming message. */
export type HandlerCallback<BData = Record<string, unknown>, E = unknown> = (message: IncomingMessage<BData, E>) => boolean | void;

/**
 * Unified handler that replaces the separate HANDLERS (persistent) and
 * MANEJADORES (ephemeral) systems.
 *
 * - persistent: stays registered until explicitly removed. Used for
 *   spontaneous server pushes (like entity change notifications).
 * - ephemeral: auto-removed after handling one definitive response.
 *   Returns false to stay alive (interim pattern).
 */
export interface Handler<BData = Record<string, unknown>, E = unknown> {
  type: 'persistent' | 'ephemeral';
  callback: HandlerCallback<BData, E>;
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
  /**
   * Override the schema-level `flattenOutgoing` for this request only.
   * When true, data keys are spread onto the root message object.
   * When false, data is nested under the payload field.
   * When omitted, the schema default is used.
   */
  flattenOutgoing?: boolean;
}

/** Options for fire() — callback-based send. */
export interface FireOptions {
  /**
   * Override the schema-level `flattenOutgoing` for this call only.
   * When true, data keys are spread onto the root message object.
   * When false, data is nested under the payload field.
   * When omitted, the schema default is used.
   */
  flattenOutgoing?: boolean;
}

/** Options for send() — fire-and-forget send. */
export interface SendOptions {
  /**
   * Override the schema-level `flattenOutgoing` for this call only.
   * When true, data keys are spread onto the root message object.
   * When false, data is nested under the payload field.
   * When omitted, the schema default is used.
   */
  flattenOutgoing?: boolean;
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
  /** Protocol schema. All fields are optional with sensible defaults. */
  protocol?: ProtocolSchema;
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
  send<PData = Record<string, unknown>>(msg: OutgoingMessage<PData>, opts?: SendOptions): void;

  /**
   * Promise-based send. Resolves on success, rejects on failure or timeout.
   * Handles interim responses transparently.
   */
  request<BData = Record<string, unknown>, PData = Record<string, unknown>, E = unknown>(msg: OutgoingMessage<PData>, options?: RequestOptions): Promise<IncomingMessage<BData, E>>;

  /**
   * Callback-based send.
   * The callback receives each response. Return false to keep listening (interim).
   * Returns an unsubscribe function.
   */
  fire<BData = Record<string, unknown>, PData = Record<string, unknown>, E = unknown>(
    msg: OutgoingMessage<PData>,
    callback: HandlerCallback<BData, E>,
    options?: FireOptions,
  ): () => void;

  /** Register a persistent handler. Returns unsubscribe function. */
  addHandler<BData = Record<string, unknown>, E = unknown>(channel: string, name: string, callback: HandlerCallback<BData, E>): () => void;
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
  readonly protocol: ResolvedProtocolSchema;
  /** Toggle debug logging. */
  debug(enabled: boolean): void;
  /** Disconnect, clear all handlers, remove all listeners. */
  destroy(): void;
}
