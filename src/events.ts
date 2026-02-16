// =============================================================================
// @silas/transport — Typed Event Emitter
//
// Minimal typed emitter (~50 lines). Replaces the 16 hook/set_hook pairs
// Replaces setter-based hooks (e.g. set_hook / hook pattern)
// with a standard event system:
//   transport.on('connected', fn)  instead of  set_al_abrir_conexion(fn)
// =============================================================================

/** Generic typed event emitter. */
export interface Emitter<TEvents extends object = Record<string, unknown>> {
  on<K extends keyof TEvents>(
    event: K,
    callback: (data: TEvents[K]) => void,
  ): () => void;

  once<K extends keyof TEvents>(
    event: K,
    callback: (data: TEvents[K]) => void,
  ): () => void;

  emit<K extends keyof TEvents>(event: K, data: TEvents[K]): void;

  off<K extends keyof TEvents>(
    event: K,
    callback: (data: TEvents[K]) => void,
  ): void;

  removeAll(event?: keyof TEvents): void;
}

type Listener = (data: never) => void;

/**
 * Create a minimal typed event emitter.
 *
 * ```ts
 * const ee = createEmitter<TransportEvents>();
 * const unsub = ee.on('connected', (evt) => { ... });
 * ee.emit('connected', evt);
 * unsub(); // or ee.off('connected', callback)
 * ```
 */
export function createEmitter<
  TEvents extends object = Record<string, unknown>,
>(): Emitter<TEvents> {
  const listeners = new Map<keyof TEvents, Set<Listener>>();

  function getSet(event: keyof TEvents): Set<Listener> {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    return set;
  }

  function on<K extends keyof TEvents>(
    event: K,
    callback: (data: TEvents[K]) => void,
  ): () => void {
    const set = getSet(event);
    const cb = callback as Listener;
    set.add(cb);
    return () => { set.delete(cb); };
  }

  function once<K extends keyof TEvents>(
    event: K,
    callback: (data: TEvents[K]) => void,
  ): () => void {
    const wrapper = (data: TEvents[K]): void => {
      off(event, wrapper);
      callback(data);
    };
    return on(event, wrapper);
  }

  function emit<K extends keyof TEvents>(event: K, data: TEvents[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    // Iterate a snapshot so listeners can safely remove themselves.
    for (const cb of [...set]) {
      (cb as (data: TEvents[K]) => void)(data);
    }
  }

  function off<K extends keyof TEvents>(
    event: K,
    callback: (data: TEvents[K]) => void,
  ): void {
    const set = listeners.get(event);
    if (set) set.delete(callback as Listener);
  }

  function removeAll(event?: keyof TEvents): void {
    if (event !== undefined) {
      listeners.delete(event);
    } else {
      listeners.clear();
    }
  }

  return { on, once, emit, off, removeAll };
}
