// =============================================================================
// @silas/transport — Main Factory
//
// createTransport() composes connection + handlers + events + protocol into
// the unified Transport API. This is the primary public entry point.
//
// Three sending modes:
//   request(msg)          → Promise<IncomingMessage>  (modern async)
//   fire(msg, callback)   → () => void                (callback pattern)
//   send(msg)             → void                      (fire-and-forget)
// =============================================================================

import type {
  Transport,
  TransportOptions,
  TransportEvents,
  TransportError,
  IncomingMessage,
  OutgoingMessage,
  RequestOptions,
  FireOptions,
  HandlerCallback,
  ReconnectOptions,
} from './types.js';
import { buildOutgoing } from './protocol.js';
import { createEmitter } from './events.js';
import { createHandlerStore } from './handlers.js';
import { createConnection } from './connection.js';

// ======================== DEFAULT RECONNECT ==================================

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  auto: true,
  delayMs: 10_000,
  maxAttempts: Infinity,
  backoff: 'fixed',
};

// ======================== FACTORY ============================================

/**
 * Create a Transport instance.
 *
 * ```ts
 * const transport = createTransport({
 *   url: 'wss://api.example.com/ws',
 *   protocol: myProtocol,
 * });
 *
 * transport.connect();
 * const res = await transport.request({ channel: 'getUser', data: { id: 5 } });
 * ```
 */
export function createTransport(options: TransportOptions): Transport {
  // ---- resolve config ----
  const schema  = options.protocol;
  const emitter = createEmitter<TransportEvents>();
  const handlers = createHandlerStore();

  let debugEnabled = options.debug ?? false;

  const reconnectConfig: Required<ReconnectOptions> | undefined =
    options.reconnect === false
      ? undefined
      : { ...DEFAULT_RECONNECT, ...(options.reconnect ?? {}) };

  const connection = createConnection({
    schema,
    emitter,
    handlers,
    reconnect: reconnectConfig,
    url: options.url,
    isDebug: () => debugEnabled,
  });

  // ---- generate unique message ID with collision avoidance ----

  function newMessageId(channel: string): number {
    let id = schema.generateId();
    // Retry once on collision.
    if (handlers.hasEphemeral(channel, id)) {
      id = schema.generateId();
    }
    return id;
  }

  // ---- public API ----

  function send(msg: OutgoingMessage): void {
    const id = newMessageId(msg.channel);
    const wire = buildOutgoing(msg, id, schema);
    connection.send(wire);
  }

  function request(
    msg: OutgoingMessage,
    opts?: RequestOptions,
  ): Promise<IncomingMessage> {
    const timeout = opts?.timeout ?? 30_000;

    return new Promise<IncomingMessage>((resolve, reject) => {
      const id = newMessageId(msg.channel);
      let timer: ReturnType<typeof setTimeout> | null = null;

      const unsub = handlers.add(msg.channel, id, {
        type: 'ephemeral',
        callback(response: IncomingMessage): boolean | void {
          // Interim — keep listening.
          if (response.code === schema.codes.interim) {
            return false;
          }

          // Definitive response — clean up timer.
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }

          if (response.code === schema.codes.success) {
            resolve(response);
          } else {
            const error: TransportError = {
              code: response.code,
              description: response.description,
              data: response.data,
              response,
            };
            reject(error);
          }
          // Return true (or void) → auto-remove handler.
        },
      });

      // Timeout.
      if (timeout > 0) {
        timer = setTimeout(() => {
          timer = null;
          unsub();
          reject(new Error(
            `Request timeout after ${timeout}ms: ${msg.channel}`,
          ));
        }, timeout);
      }

      // Send.
      const wire = buildOutgoing(msg, id, schema);
      connection.send(wire);
    });
  }

  function fire(
    msg: OutgoingMessage,
    callback: HandlerCallback,
    _opts?: FireOptions,
  ): () => void {
    const id = newMessageId(msg.channel);

    const unsub = handlers.add(msg.channel, id, {
      type: 'ephemeral',
      callback,
    });

    const wire = buildOutgoing(msg, id, schema);
    connection.send(wire);

    return unsub;
  }

  function addHandler(
    channel: string,
    name: string,
    callback: HandlerCallback,
  ): () => void {
    return handlers.add(channel, name, {
      type: 'persistent',
      callback,
      name,
    });
  }

  function removeHandler(channel: string, name: string): boolean {
    return handlers.remove(channel, name);
  }

  function on<K extends keyof TransportEvents>(
    event: K,
    callback: (data: TransportEvents[K]) => void,
  ): () => void {
    return emitter.on(event, callback);
  }

  function once<K extends keyof TransportEvents>(
    event: K,
    callback: (data: TransportEvents[K]) => void,
  ): () => void {
    return emitter.once(event, callback);
  }

  function debug(enabled: boolean): void {
    debugEnabled = enabled;
  }

  function destroy(): void {
    connection.destroy();
    emitter.removeAll();
  }

  // ---- compose the Transport object ----

  const transport: Transport = {
    connect: () => connection.connect(),
    disconnect: (opts) => connection.disconnect(opts),
    get state() { return connection.getState(); },

    send,
    request,
    fire,

    addHandler,
    removeHandler,

    on,
    once,

    protocol: schema,
    debug,
    destroy,
  };

  return transport;
}
