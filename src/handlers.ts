// =============================================================================
// @silas/transport — Unified Handler Registry
//
// Replaces separate persistent and ephemeral handler systems with a single
// registry.
//
// Routing priority:
//   1. Ephemeral handler matched by (channel, messageId) — exact match
//   2. Persistent handlers matched by (channel) — all executed
//   3. If nothing matched → message is unhandled
//
// Ephemeral handlers auto-remove after a definitive response (callback
// returns true or void). Return false to keep alive (interim pattern).
// =============================================================================

import type { Handler, IncomingMessage } from './types.js';

// ======================== HANDLER STORE ======================================

export interface HandlerStore {
  /**
   * Register a handler.
   * - Persistent: key is the handler name (string).
   * - Ephemeral: key is the messageId (number).
   * Returns an unsubscribe function.
   */
  add(channel: string, key: string | number, handler: Handler): () => void;

  /** Remove a handler by channel + key. */
  remove(channel: string, key: string | number): boolean;

  /**
   * Route an incoming message to the appropriate handler(s).
   * Returns true if at least one handler processed the message.
   */
  execute(message: IncomingMessage): boolean;

  /** Check if an ephemeral handler exists for (channel, messageId). */
  hasEphemeral(channel: string, messageId: number): boolean;

  /** Look up the channel for a given messageId via the secondary index. */
  findChannelByMessageId(messageId: number): string | undefined;

  /** Clear all handlers. */
  clear(): void;

  /**
   * Clear stale ephemeral handlers for a given channel (or all channels).
   */
  clearStale(channel?: string): void;
}

// ======================== IMPLEMENTATION =====================================

/**
 * Create a new handler store.
 *
 * Internal structure:
 *   ephemeral:  Map< channel, Map< messageId (number), Handler > >
 *   persistent: Map< channel, Map< name (string),      Handler > >
 */
export function createHandlerStore(): HandlerStore {
  const ephemeral  = new Map<string, Map<number, Handler>>();
  const persistent = new Map<string, Map<string, Handler>>();
  /** Secondary index: messageId → channel for O(1) ID-only lookups. */
  const idToChannel = new Map<number, string>();

  // ---- helpers ----

  function getEphemeralMap(channel: string): Map<number, Handler> {
    let map = ephemeral.get(channel);
    if (!map) { map = new Map(); ephemeral.set(channel, map); }
    return map;
  }

  function getPersistentMap(channel: string): Map<string, Handler> {
    let map = persistent.get(channel);
    if (!map) { map = new Map(); persistent.set(channel, map); }
    return map;
  }

  // ---- public API ----

  function add(
    channel: string,
    key: string | number,
    handler: Handler,
  ): () => void {
    if (handler.type === 'ephemeral' && typeof key === 'number') {
      getEphemeralMap(channel).set(key, handler);
      idToChannel.set(key, channel);
    } else if (handler.type === 'persistent' && typeof key === 'string') {
      getPersistentMap(channel).set(key, handler);
    } else {
      throw new Error(
        `Invalid handler registration: type=${handler.type}, key type=${typeof key}. ` +
        `Ephemeral handlers require a numeric key (messageId), persistent require a string key (name).`,
      );
    }

    // Return unsubscribe.
    return () => { remove(channel, key); };
  }

  function remove(channel: string, key: string | number): boolean {
    if (typeof key === 'number') {
      const map = ephemeral.get(channel);
      if (!map) return false;
      const deleted = map.delete(key);
      if (deleted) idToChannel.delete(key);
      if (map.size === 0) ephemeral.delete(channel);
      return deleted;
    } else {
      const map = persistent.get(channel);
      if (!map) return false;
      const deleted = map.delete(key);
      if (map.size === 0) persistent.delete(channel);
      return deleted;
    }
  }

  function execute(message: IncomingMessage): boolean {
    const channel = message.channel;
    const msgId = message.messageId;

    // 1. Try ephemeral handler (exact channel + messageId match).
    const ephMap = ephemeral.get(channel);
    if (ephMap && msgId !== 0) {
      const handler = ephMap.get(msgId);
      if (handler) {
        const result = handler.callback(message);
        // Auto-remove unless callback explicitly returns false (interim).
        if (result !== false) {
          ephMap.delete(msgId);
          idToChannel.delete(msgId);
          if (ephMap.size === 0) ephemeral.delete(channel);
        }
        return true;
      }
    }

    // 2. Fall through to persistent handlers.
    const perMap = persistent.get(channel);
    if (perMap && perMap.size > 0) {
      for (const handler of perMap.values()) {
        handler.callback(message);
      }
      return true;
    }

    // 3. ID-only fallback: response arrived with no channel (or wrong channel)
    //    but has a messageId — look up the original channel via secondary index.
    if (msgId !== 0) {
      const resolvedChannel = idToChannel.get(msgId);
      if (resolvedChannel && resolvedChannel !== channel) {
        const fallbackMap = ephemeral.get(resolvedChannel);
        if (fallbackMap) {
          const handler = fallbackMap.get(msgId);
          if (handler) {
            const result = handler.callback(message);
            if (result !== false) {
              fallbackMap.delete(msgId);
              idToChannel.delete(msgId);
              if (fallbackMap.size === 0) ephemeral.delete(resolvedChannel);
            }
            return true;
          }
        }
      }
    }

    // 4. Unhandled.
    return false;
  }

  function hasEphemeral(channel: string, messageId: number): boolean {
    return ephemeral.get(channel)?.has(messageId) ?? false;
  }

  function clear(): void {
    ephemeral.clear();
    persistent.clear();
    idToChannel.clear();
  }

  function clearStale(channel?: string): void {
    if (channel) {
      // Remove index entries for this channel's ephemeral handlers.
      const map = ephemeral.get(channel);
      if (map) {
        for (const msgId of map.keys()) {
          idToChannel.delete(msgId);
        }
      }
      ephemeral.delete(channel);
    } else {
      // Clear all ephemeral + index.
      ephemeral.clear();
      idToChannel.clear();
    }
  }

  function findChannelByMessageId(messageId: number): string | undefined {
    return idToChannel.get(messageId);
  }

  return { add, remove, execute, hasEphemeral, findChannelByMessageId, clear, clearStale };
}
