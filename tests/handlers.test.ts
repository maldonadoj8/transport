// =============================================================================
// Tests: handlers.ts
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { createHandlerStore } from '../src/handlers.js';
import type { IncomingMessage } from '../src/types.js';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: 'test',
    messageId: 1,
    code: 'OK',
    description: '',
    data: {},
    raw: {},
    ...overrides,
  };
}

describe('createHandlerStore', () => {
  // ---- persistent handlers ----

  it('adds and executes persistent handler', () => {
    const store = createHandlerStore();
    const fn = vi.fn();
    store.add('usuario', 'main', { type: 'persistent', callback: fn });

    const msg = makeMsg({ channel: 'usuario', messageId: 0 });
    const handled = store.execute(msg);

    expect(handled).toBe(true);
    expect(fn).toHaveBeenCalledWith(msg);
  });

  it('executes all persistent handlers for same channel', () => {
    const store = createHandlerStore();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    store.add('usuario', 'handler-a', { type: 'persistent', callback: fn1 });
    store.add('usuario', 'handler-b', { type: 'persistent', callback: fn2 });

    store.execute(makeMsg({ channel: 'usuario', messageId: 0 }));

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('removes persistent handler by name', () => {
    const store = createHandlerStore();
    const fn = vi.fn();
    store.add('usuario', 'main', { type: 'persistent', callback: fn });
    const removed = store.remove('usuario', 'main');

    expect(removed).toBe(true);
    expect(store.execute(makeMsg({ channel: 'usuario', messageId: 0 }))).toBe(false);
  });

  it('persistent handler survives across multiple executions', () => {
    const store = createHandlerStore();
    const fn = vi.fn();
    store.add('usuario', 'main', { type: 'persistent', callback: fn });

    store.execute(makeMsg({ channel: 'usuario', messageId: 0 }));
    store.execute(makeMsg({ channel: 'usuario', messageId: 0 }));
    store.execute(makeMsg({ channel: 'usuario', messageId: 0 }));

    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ---- ephemeral handlers ----

  it('adds and executes ephemeral handler', () => {
    const store = createHandlerStore();
    const fn = vi.fn(() => true);
    store.add('usuario', 42, { type: 'ephemeral', callback: fn });

    const msg = makeMsg({ channel: 'usuario', messageId: 42 });
    const handled = store.execute(msg);

    expect(handled).toBe(true);
    expect(fn).toHaveBeenCalledWith(msg);
  });

  it('auto-removes ephemeral handler after definitive response', () => {
    const store = createHandlerStore();
    const fn = vi.fn(); // returns undefined → auto-remove
    store.add('usuario', 42, { type: 'ephemeral', callback: fn });

    store.execute(makeMsg({ channel: 'usuario', messageId: 42 }));
    // Second call — handler should be gone.
    const handled = store.execute(makeMsg({ channel: 'usuario', messageId: 42 }));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(handled).toBe(false);
  });

  it('keeps ephemeral handler alive when callback returns false (NEUTRO)', () => {
    const store = createHandlerStore();
    let callCount = 0;
    const fn = vi.fn(() => {
      callCount++;
      // First two calls return false (interim), third returns true (definitive).
      return callCount < 3 ? false : true;
    });
    store.add('usuario', 42, { type: 'ephemeral', callback: fn });

    store.execute(makeMsg({ channel: 'usuario', messageId: 42 }));
    expect(store.hasEphemeral('usuario', 42)).toBe(true); // still alive

    store.execute(makeMsg({ channel: 'usuario', messageId: 42 }));
    expect(store.hasEphemeral('usuario', 42)).toBe(true); // still alive

    store.execute(makeMsg({ channel: 'usuario', messageId: 42 }));
    expect(store.hasEphemeral('usuario', 42)).toBe(false); // removed

    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ---- routing priority ----

  it('ephemeral takes priority over persistent', () => {
    const store = createHandlerStore();
    const ephFn = vi.fn();
    const perFn = vi.fn();
    store.add('usuario', 42, { type: 'ephemeral', callback: ephFn });
    store.add('usuario', 'main', { type: 'persistent', callback: perFn });

    store.execute(makeMsg({ channel: 'usuario', messageId: 42 }));

    expect(ephFn).toHaveBeenCalledTimes(1);
    expect(perFn).not.toHaveBeenCalled();
  });

  it('falls through to persistent when no ephemeral matches', () => {
    const store = createHandlerStore();
    const perFn = vi.fn();
    store.add('usuario', 'main', { type: 'persistent', callback: perFn });

    store.execute(makeMsg({ channel: 'usuario', messageId: 99 }));

    expect(perFn).toHaveBeenCalledTimes(1);
  });

  it('spontaneous push (messageId=0) goes to persistent', () => {
    const store = createHandlerStore();
    const perFn = vi.fn();
    store.add('usuario', 'main', { type: 'persistent', callback: perFn });

    store.execute(makeMsg({ channel: 'usuario', messageId: 0 }));

    expect(perFn).toHaveBeenCalledTimes(1);
  });

  // ---- unsubscribe function ----

  it('add() returns working unsubscribe function', () => {
    const store = createHandlerStore();
    const fn = vi.fn();
    const unsub = store.add('usuario', 'main', { type: 'persistent', callback: fn });

    unsub();
    store.execute(makeMsg({ channel: 'usuario', messageId: 0 }));

    expect(fn).not.toHaveBeenCalled();
  });

  // ---- hasEphemeral ----

  it('hasEphemeral returns true/false correctly', () => {
    const store = createHandlerStore();
    expect(store.hasEphemeral('x', 1)).toBe(false);

    store.add('x', 1, { type: 'ephemeral', callback: () => {} });
    expect(store.hasEphemeral('x', 1)).toBe(true);
  });

  // ---- unhandled ----

  it('returns false when no handler matches', () => {
    const store = createHandlerStore();
    expect(store.execute(makeMsg({ channel: 'unknown' }))).toBe(false);
  });

  // ---- clear / clearStale ----

  it('clear() removes all handlers', () => {
    const store = createHandlerStore();
    store.add('a', 'x', { type: 'persistent', callback: () => {} });
    store.add('b', 1, { type: 'ephemeral', callback: () => {} });
    store.clear();

    expect(store.execute(makeMsg({ channel: 'a', messageId: 0 }))).toBe(false);
    expect(store.hasEphemeral('b', 1)).toBe(false);
  });

  it('clearStale() removes ephemeral handlers for specific interface', () => {
    const store = createHandlerStore();
    const perFn = vi.fn();
    store.add('a', 1, { type: 'ephemeral', callback: () => {} });
    store.add('a', 'main', { type: 'persistent', callback: perFn });
    store.clearStale('a');

    expect(store.hasEphemeral('a', 1)).toBe(false);
    // Persistent should still be there.
    store.execute(makeMsg({ channel: 'a', messageId: 0 }));
    expect(perFn).toHaveBeenCalledTimes(1);
  });

  it('clearStale() without arg clears all ephemeral', () => {
    const store = createHandlerStore();
    store.add('a', 1, { type: 'ephemeral', callback: () => {} });
    store.add('b', 2, { type: 'ephemeral', callback: () => {} });
    store.clearStale();

    expect(store.hasEphemeral('a', 1)).toBe(false);
    expect(store.hasEphemeral('b', 2)).toBe(false);
  });

  // ---- validation ----

  it('throws on invalid handler registration', () => {
    const store = createHandlerStore();
    expect(() =>
      store.add('x', 'name', { type: 'ephemeral', callback: () => {} }),
    ).toThrow('Invalid handler registration');

    expect(() =>
      store.add('x', 42, { type: 'persistent', callback: () => {} }),
    ).toThrow('Invalid handler registration');
  });

  // ---- ID-only fallback ----

  it('routes by messageId alone when channel does not match', () => {
    const store = createHandlerStore();
    const fn = vi.fn();
    // Register ephemeral handler on channel 'market_subscribe' with msgId 42.
    store.add('market_subscribe', 42, { type: 'ephemeral', callback: fn });

    // Response arrives with empty channel but matching messageId.
    const msg = makeMsg({ channel: '', messageId: 42 });
    const handled = store.execute(msg);

    expect(handled).toBe(true);
    expect(fn).toHaveBeenCalledWith(msg);
  });

  it('ID-only fallback auto-removes ephemeral handler', () => {
    const store = createHandlerStore();
    const fn = vi.fn();
    store.add('market_subscribe', 42, { type: 'ephemeral', callback: fn });

    store.execute(makeMsg({ channel: '', messageId: 42 }));
    // Handler should be auto-removed.
    const handled = store.execute(makeMsg({ channel: '', messageId: 42 }));

    expect(handled).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ID-only fallback respects interim (false return)', () => {
    const store = createHandlerStore();
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      return calls < 2 ? false : true;
    });
    store.add('ch', 99, { type: 'ephemeral', callback: fn });

    // First call returns false — handler stays.
    store.execute(makeMsg({ channel: '', messageId: 99 }));
    expect(store.hasEphemeral('ch', 99)).toBe(true);

    // Second call returns true — handler removed.
    store.execute(makeMsg({ channel: '', messageId: 99 }));
    expect(store.hasEphemeral('ch', 99)).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ---- findChannelByMessageId ----

  it('findChannelByMessageId returns channel for registered ephemeral', () => {
    const store = createHandlerStore();
    store.add('usuario', 42, { type: 'ephemeral', callback: () => {} });
    expect(store.findChannelByMessageId(42)).toBe('usuario');
  });

  it('findChannelByMessageId returns undefined for unknown messageId', () => {
    const store = createHandlerStore();
    expect(store.findChannelByMessageId(999)).toBeUndefined();
  });

  it('findChannelByMessageId clears on remove', () => {
    const store = createHandlerStore();
    store.add('usuario', 42, { type: 'ephemeral', callback: () => {} });
    store.remove('usuario', 42);
    expect(store.findChannelByMessageId(42)).toBeUndefined();
  });

  it('findChannelByMessageId clears on clear()', () => {
    const store = createHandlerStore();
    store.add('a', 1, { type: 'ephemeral', callback: () => {} });
    store.add('b', 2, { type: 'ephemeral', callback: () => {} });
    store.clear();
    expect(store.findChannelByMessageId(1)).toBeUndefined();
    expect(store.findChannelByMessageId(2)).toBeUndefined();
  });

  it('findChannelByMessageId clears on clearStale()', () => {
    const store = createHandlerStore();
    store.add('a', 1, { type: 'ephemeral', callback: () => {} });
    store.add('b', 2, { type: 'ephemeral', callback: () => {} });
    store.clearStale('a');
    expect(store.findChannelByMessageId(1)).toBeUndefined();
    // Channel 'b' should still be indexed.
    expect(store.findChannelByMessageId(2)).toBe('b');
  });

  // ---- callback return value edge cases ----

  it('auto-removes ephemeral when callback returns null (not exactly false)', () => {
    const store = createHandlerStore();
    const fn = vi.fn(() => null as unknown as boolean);
    store.add('ch', 1, { type: 'ephemeral', callback: fn });

    store.execute(makeMsg({ channel: 'ch', messageId: 1 }));
    expect(store.hasEphemeral('ch', 1)).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('auto-removes ephemeral when callback returns undefined (not exactly false)', () => {
    const store = createHandlerStore();
    const fn = vi.fn(() => undefined);
    store.add('ch', 2, { type: 'ephemeral', callback: fn });

    store.execute(makeMsg({ channel: 'ch', messageId: 2 }));
    expect(store.hasEphemeral('ch', 2)).toBe(false);
  });

  it('auto-removes ephemeral when callback returns 0 (not exactly false)', () => {
    const store = createHandlerStore();
    const fn = vi.fn(() => 0 as unknown as boolean);
    store.add('ch', 3, { type: 'ephemeral', callback: fn });

    store.execute(makeMsg({ channel: 'ch', messageId: 3 }));
    expect(store.hasEphemeral('ch', 3)).toBe(false);
  });

  it('auto-removes ephemeral when callback returns empty string (not exactly false)', () => {
    const store = createHandlerStore();
    const fn = vi.fn(() => '' as unknown as boolean);
    store.add('ch', 4, { type: 'ephemeral', callback: fn });

    store.execute(makeMsg({ channel: 'ch', messageId: 4 }));
    expect(store.hasEphemeral('ch', 4)).toBe(false);
  });

  it('keeps handler alive only when callback returns exactly false', () => {
    const store = createHandlerStore();
    const fn = vi.fn(() => false as boolean);
    store.add('ch', 5, { type: 'ephemeral', callback: fn });

    store.execute(makeMsg({ channel: 'ch', messageId: 5 }));
    expect(store.hasEphemeral('ch', 5)).toBe(true);
  });

  it('does not propagate callback throw — subsequent handlers still run', () => {
    const store = createHandlerStore();
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const safe = vi.fn();
    store.add('ch', 10, { type: 'ephemeral', callback: throwing });
    store.add('ch', 'after', { type: 'persistent', callback: safe });

    expect(() => store.execute(makeMsg({ channel: 'ch', messageId: 10 }))).toThrow('boom');
    // Persistent handler on same channel was not reached because ephemeral matched first.
    expect(safe).not.toHaveBeenCalled();
  });

  it('handler can remove itself during execution without corrupting store', () => {
    const store = createHandlerStore();
    let unsub!: () => void;

    const fn = vi.fn(() => {
      // Remove self during callback.
      unsub();
    });

    unsub = store.add('ch', 'self-remove', { type: 'persistent', callback: fn });
    store.execute(makeMsg({ channel: 'ch', messageId: 0 }));

    expect(fn).toHaveBeenCalledTimes(1);
    // Should be removed — second execute should not call fn again.
    store.execute(makeMsg({ channel: 'ch', messageId: 0 }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
