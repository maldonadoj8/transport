// =============================================================================
// @silas/transport — Connection Manager
//
// Encapsulates all WebSocket lifecycle: connect, disconnect, send, receive,
// auto-reconnect.
//
// Features:
//   - Configurable reconnect (delay, max attempts, backoff)
//   - Event-based lifecycle
//   - Idempotent connect
//   - Stale handler cleanup on disconnect
// =============================================================================

import type {
  ResolvedProtocolSchema,
  TransportState,
  TransportEvents,
  ReconnectOptions,
  IncomingMessage,
} from './types.js';
import type { Emitter } from './events.js';
import type { HandlerStore } from './handlers.js';
import { normalizeIncoming } from './protocol.js';

// ======================== TYPES ==============================================

/** @internal */
export interface ConnectionDeps {
  /** Resolved protocol schema. */
  schema: ResolvedProtocolSchema;
  /** Event emitter. */
  emitter: Emitter<TransportEvents>;
  /** Handler store for routing inbound messages. */
  handlers: HandlerStore;
  /** Resolved reconnect config (undefined = disabled). */
  reconnect: Required<ReconnectOptions> | undefined;
  /** URL string or lazy getter. */
  url: string | (() => string);
  /** Debug flag reference (getter so it reads the live value). */
  isDebug: () => boolean;
}

export interface Connection {
  connect(): void;
  disconnect(options?: { clean?: boolean }): void;
  send(payload: Record<string, unknown>): void;
  getState(): TransportState;
  destroy(): void;
}

// ======================== IMPLEMENTATION =====================================

/** WebSocket readyState constants (mirrors the spec). */
const WS_CONNECTING = 0;
const WS_OPEN       = 1;
const WS_CLOSING    = 2;
const WS_CLOSED     = 3;

export function createConnection(deps: ConnectionDeps): Connection {
  const { schema, emitter, handlers } = deps;

  let ws: WebSocket | null = null;
  let state: TransportState = 'disconnected';
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let destroyed = false;

  // ---- helpers ----

  function resolveUrl(): string {
    return typeof deps.url === 'function' ? deps.url() : deps.url;
  }

  function log(...args: unknown[]): void {
    if (deps.isDebug()) {
      console.log('[silas/transport]', ...args);
    }
  }

  function setState(next: TransportState): void {
    state = next;
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function computeDelay(): number {
    if (!deps.reconnect) return 0;
    const { delayMs, backoff } = deps.reconnect;
    if (backoff === 'exponential') {
      // Exponential backoff capped at 60s.
      return Math.min(delayMs * Math.pow(2, reconnectAttempt), 60_000);
    }
    return delayMs;
  }

  function scheduleReconnect(): void {
    if (!deps.reconnect || !deps.reconnect.auto || destroyed) return;
    if (reconnectAttempt >= deps.reconnect.maxAttempts) {
      log('Max reconnect attempts reached:', deps.reconnect.maxAttempts);
      return;
    }

    const delay = computeDelay();
    reconnectAttempt++;
    setState('reconnecting');
    emitter.emit('reconnecting', { attempt: reconnectAttempt, delayMs: delay });
    log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // ---- WebSocket event handlers ----

  function onOpen(evt: Event): void {
    reconnectAttempt = 0;
    setState('connected');
    log('Connected');
    emitter.emit('connected', evt);
  }

  function onClose(evt: CloseEvent): void {
    ws = null;
    const prev = state;
    setState('disconnected');
    log('Disconnected', evt.code, evt.reason);
    emitter.emit('disconnected', {
      code: evt.code,
      reason: evt.reason,
      wasClean: evt.wasClean,
    });

    // Auto-reconnect if not intentionally disconnected.
    if (prev !== 'disconnected' && !destroyed) {
      scheduleReconnect();
    }
  }

  function onError(evt: Event): void {
    log('WebSocket error', evt);
    emitter.emit('error', evt);
  }

  function onMessage(evt: MessageEvent): void {
    const raw = typeof evt.data === 'string' ? evt.data : String(evt.data);
    emitter.emit('message:raw', { data: raw });

    // Decode.
    const parsed = schema.decode(raw);
    if (!parsed) {
      log('Failed to decode message:', raw);
      return;
    }

    // Normalize to canonical shape.
    const message: IncomingMessage = normalizeIncoming(parsed, schema);
    log('(Received) ← ', {
      raw: raw,
      parsed: parsed,
      normalized: message,
    });
    emitter.emit('message:parsed', message);

    // Validate minimum fields.
    // Allow messages through if they have a channel OR a messageId (for ID-only
    // fallback routing — e.g. responses that omit the channel field).
    if (!message.channel && message.messageId === 0) {
      log('Message missing channel and messageId, dropping');
      return;
    }

    // Route to handlers.
    const handled = handlers.execute(message);
    if (handled) {
      log('Handler matched:', message.channel, message.messageId);
    } else {
      emitter.emit('message:unhandled', message);
      log('Unhandled message:', message.channel, message.messageId);
    }
  }

  // ---- public API ----

  function connect(): void {
    if (destroyed) return;

    // Idempotent: don't re-open if already connecting or connected.
    if (ws) {
      const rs = ws.readyState;
      if (rs === WS_OPEN || rs === WS_CONNECTING) {
        log('Already connected/connecting, skipping');
        return;
      }
    }

    clearReconnectTimer();
    const url = resolveUrl();
    log('Connecting to', url);
    setState('connecting');
    emitter.emit('connecting', undefined);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      log('WebSocket constructor error:', err);
      emitter.emit('error', new Event('error'));
      scheduleReconnect();
      return;
    }

    ws.onopen    = onOpen;
    ws.onclose   = onClose;
    ws.onerror   = onError;
    ws.onmessage = onMessage;
  }

  function disconnect(options?: { clean?: boolean }): void {
    clearReconnectTimer();
    reconnectAttempt = 0;

    if (options?.clean) {
      handlers.clearStale();
    }

    if (ws) {
      const rs = ws.readyState;
      if (rs !== WS_CLOSED && rs !== WS_CLOSING) {
        log('Closing WebSocket');
        ws.close();
      }
      ws = null;
    }

    setState('disconnected');
  }

  function send(payload: Record<string, unknown>): void {
    emitter.emit('send:before', { payload });

    if (!ws || ws.readyState !== WS_OPEN) {
      const reason = ws
        ? `WebSocket readyState=${ws.readyState}`
        : 'No WebSocket instance';
      log('Send failed:', reason);
      emitter.emit('send:error', { payload, reason });

      // Attempt reconnect on send failure.
      if (!ws || ws.readyState === WS_CLOSED || ws.readyState === WS_CLOSING) {
        if (deps.reconnect?.auto && !destroyed) {
          clearReconnectTimer();
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 1_000);
        }
      }
      return;
    }

    const encoded = schema.encode(payload);
    log('(Sent) →', payload);
    ws.send(encoded);
    emitter.emit('send:after', { payload });
  }

  function getState(): TransportState {
    return state;
  }

  function destroy(): void {
    destroyed = true;
    disconnect();
    handlers.clear();
  }

  return { connect, disconnect, send, getState, destroy };
}
