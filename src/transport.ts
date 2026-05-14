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
import { buildOutgoing, resolveSchema } from './protocol.js';
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
  const schema  = resolveSchema(options.protocol);
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

  function resolveChannel(msg: OutgoingMessage<unknown>): string {
    return msg.channel ?? '*';
  }

  function newMessageId(channel: string): number {
    const MAX_ATTEMPTS = 10;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const id = schema.generateId();
      if (handlers.findChannelByMessageId(id) === undefined) {
        return id;
      }
    }
    throw new Error(
      `Failed to generate a unique message ID for channel "${channel}" after ${MAX_ATTEMPTS} attempts. ` +
      `Check your generateId() implementation.`,
    );
  }

  // ---- public API ----

  function send<PData = Record<string, unknown>>(msg: OutgoingMessage<PData>): void {
    const channel = resolveChannel(msg);
    const id = newMessageId(channel);
    const wire = buildOutgoing(msg, id, schema);
    connection.send(wire);
  }

  function request<BData = Record<string, unknown>, PData = Record<string, unknown>, E = unknown>(
    msg: OutgoingMessage<PData>,
    opts?: RequestOptions,
  ): Promise<IncomingMessage<BData, E>> {
    const timeout = opts?.timeout ?? 30_000;

    return new Promise<IncomingMessage<BData, E>>((resolve, reject) => {
      const channel = resolveChannel(msg);
      const id = newMessageId(channel);
      
      let timer: ReturnType<typeof setTimeout> | null = null;

      const unsub = handlers.add(channel, id, {
        type: 'ephemeral',
        callback(response: IncomingMessage): boolean | void {
          const codes = schema.codes;

          // 1. Interim — keep listening.
          if (codes?.interim && response.code === codes.interim) {
            return false;
          }

          // Definitive response — clean up timer.
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }

          // 2. Explicit error match — reject.
          if (codes?.error && codes.error.includes(response.code)) {
            const error: TransportError = {
              code: response.code,
              error: response.error,
              data: response.data,
              response,
            };
            reject(error);
            return; // auto-remove
          }

          // 3. Success: explicit match OR no success code defined (treat all as success).
          if (!codes?.success || response.code === codes.success) {
            resolve(response as IncomingMessage<BData, E>);
            return; // auto-remove
          }

          // 4. Success code is defined but response doesn't match — treat as error.
          const error: TransportError = {
            code: response.code,
            error: response.error,
            data: response.data,
            response,
          };
          reject(error);
          // Return void → auto-remove handler.
        },
      });

      // Timeout.
      if (timeout > 0) {
        timer = setTimeout(() => {
          timer = null;
          unsub();
          reject(new Error(
            `Request timeout after ${timeout}ms: ${channel}`,
          ));
        }, timeout);
      }

      // Send.
      const wire = buildOutgoing(msg, id, schema);
      connection.send(wire);
    });
  }

  function fire<BData = Record<string, unknown>, PData = Record<string, unknown>, E = unknown>(
    msg: OutgoingMessage<PData>,
    callback: HandlerCallback<BData, E>,
    _opts?: FireOptions,
  ): () => void {
    const channel = resolveChannel(msg);
    const id = newMessageId(channel);

    const unsub = handlers.add(channel, id, {
      type: 'ephemeral',
      callback: callback as HandlerCallback,
    });

    const wire = buildOutgoing(msg, id, schema);
    connection.send(wire);

    return unsub;
  }

  function addHandler<BData = Record<string, unknown>, E = unknown>(
    channel: string,
    name: string,
    callback: HandlerCallback<BData, E>,
  ): () => void {
    return handlers.add(channel, name, {
      type: 'persistent',
      callback: callback as HandlerCallback,
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
