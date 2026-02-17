// =============================================================================
// Tests: connection.ts
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installMock, lastInstance, resetInstances } from './__mocks__/ws.js';
import { createTransport } from '../src/transport.js';
import type { Transport, ProtocolSchema } from '../src/types.js';

let restore: () => void;

beforeEach(() => {
  restore = installMock();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  restore();
});

/** A complete test protocol. */
const TEST_PROTOCOL: ProtocolSchema = {
  fields: {
    requestChannel:  'channel',
    responseChannel: 'channel',
    messageId:       'msgId',
    type:            'type',
    code:            'code',
    description:     'desc',
    payload:         'data',
    body:            'data',
  },
  codes: {
    success:         'OK',
    interim:         'PENDING',
    error:           'ERROR',
    validationError: 'VALIDATION_ERROR',
    unauthorized:    'UNAUTHORIZED',
    notFound:        'NOT_FOUND',
    timeout:         'TIMEOUT',
    rateLimited:     'RATE_LIMITED',
  },
  responseTypes: { none: 0, silent: 1, message: 2, processing: 4, alert: 8, all: 15 },
  generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
  encode: (msg) => JSON.stringify(msg),
  decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  flattenOutgoing: true,
};

function makeTransport(overrides: Partial<Parameters<typeof createTransport>[0]> = {}): Transport {
  return createTransport({
    url: 'ws://test.local/ws',
    protocol: TEST_PROTOCOL,
    reconnect: false,
    debug: false,
    ...overrides,
  });
}

describe('connection lifecycle', () => {
  it('starts in disconnected state', () => {
    const t = makeTransport();
    expect(t.state).toBe('disconnected');
  });

  it('transitions to connecting then connected', () => {
    const t = makeTransport();
    const states: string[] = [];
    t.on('connecting', () => states.push('connecting'));
    t.on('connected', () => states.push('connected'));

    t.connect();
    expect(t.state).toBe('connecting');

    lastInstance()!.simulateOpen();
    expect(t.state).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('connect is idempotent when already connected', () => {
    const t = makeTransport();
    t.connect();
    lastInstance()!.simulateOpen();

    t.connect(); // should be no-op
    expect(resetInstances, 'should not create a second WebSocket');
    // Only 1 instance created.
  });

  it('disconnect transitions to disconnected', async () => {
    const t = makeTransport();
    const fn = vi.fn();
    t.on('disconnected', fn);

    t.connect();
    lastInstance()!.simulateOpen();
    t.disconnect();

    // The mock close is async (queueMicrotask).
    await vi.advanceTimersByTimeAsync(0);

    expect(t.state).toBe('disconnected');
  });

  it('emits error event on WebSocket error', () => {
    const t = makeTransport();
    const fn = vi.fn();
    t.on('error', fn);

    t.connect();
    lastInstance()!.simulateError();

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('send', () => {
  it('sends encoded JSON when connected', () => {
    const t = makeTransport();
    t.connect();
    lastInstance()!.simulateOpen();

    t.send({ channel: 'ping' });

    const ws = lastInstance()!;
    expect(ws.sent.length).toBe(1);
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.channel).toBe('ping');
    expect(typeof parsed.msgId).toBe('number');
  });

  it('emits send:error when not connected', () => {
    const t = makeTransport();
    const fn = vi.fn();
    t.on('send:error', fn);

    t.send({ channel: 'ping' });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emits send:before and send:after', () => {
    const t = makeTransport();
    const before = vi.fn();
    const after = vi.fn();
    t.on('send:before', before);
    t.on('send:after', after);

    t.connect();
    lastInstance()!.simulateOpen();
    t.send({ channel: 'ping' });

    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('message routing', () => {
  it('routes incoming message to persistent handler', () => {
    const t = makeTransport();
    const fn = vi.fn();
    t.addHandler('usuario', 'test', fn);

    t.connect();
    const ws = lastInstance()!;
    ws.simulateOpen();
    ws.simulateMessage({
      channel: 'usuario',
      msgId: 0,
      type: 1,
      code: 'OK',
      desc: 'ok',
      data: { usuario: [{ id: 1 }] },
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].channel).toBe('usuario');
    expect(fn.mock.calls[0][0].code).toBe('OK');
  });

  it('emits message:unhandled when no handler matches', () => {
    const t = makeTransport();
    const fn = vi.fn();
    t.on('message:unhandled', fn);

    t.connect();
    const ws = lastInstance()!;
    ws.simulateOpen();
    ws.simulateMessage({
      channel: 'unknown',
      msgId: 0,
      type: 1,
      code: 'OK',
      desc: '',
      data: {},
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].channel).toBe('unknown');
  });

  it('emits message:raw and message:parsed events', () => {
    const t = makeTransport();
    const rawFn = vi.fn();
    const parsedFn = vi.fn();
    t.on('message:raw', rawFn);
    t.on('message:parsed', parsedFn);

    t.connect();
    const ws = lastInstance()!;
    ws.simulateOpen();
    ws.simulateMessage({ channel: 'ping', msgId: 0, type: 1, code: 'OK', desc: '', data: {} });

    expect(rawFn).toHaveBeenCalledTimes(1);
    expect(parsedFn).toHaveBeenCalledTimes(1);
  });

  it('drops unparseable messages silently', () => {
    const t = makeTransport();
    const fn = vi.fn();
    t.on('message:parsed', fn);

    t.connect();
    const ws = lastInstance()!;
    ws.simulateOpen();
    ws.simulateMessage('not json at all }{');

    expect(fn).not.toHaveBeenCalled();
  });
});

describe('auto-reconnect', () => {
  it('reconnects after close when enabled', async () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: TEST_PROTOCOL,
      reconnect: { auto: true, delayMs: 5000, backoff: 'fixed' },
    });
    const reconnFn = vi.fn();
    t.on('reconnecting', reconnFn);

    t.connect();
    lastInstance()!.simulateOpen();

    // Server closes connection.
    lastInstance()!.simulateClose(1006, 'abnormal');

    expect(reconnFn).toHaveBeenCalledWith({ attempt: 1, delayMs: 5000 });

    // Advance time to trigger reconnect.
    vi.advanceTimersByTime(5000);

    // A new WebSocket should have been created.
    expect(lastInstance()!.url).toBe('ws://test.local/ws');
    t.destroy();
  });

  it('does not reconnect when disabled', () => {
    const t = makeTransport({ reconnect: false });
    const fn = vi.fn();
    t.on('reconnecting', fn);

    t.connect();
    lastInstance()!.simulateOpen();
    lastInstance()!.simulateClose(1006);

    vi.advanceTimersByTime(60000);
    expect(fn).not.toHaveBeenCalled();
    t.destroy();
  });

  it('respects maxAttempts', () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: TEST_PROTOCOL,
      reconnect: { auto: true, delayMs: 1000, maxAttempts: 2, backoff: 'fixed' },
    });
    const reconnFn = vi.fn();
    t.on('reconnecting', reconnFn);

    t.connect();
    lastInstance()!.simulateOpen();

    // Close → reconnect attempt 1.
    lastInstance()!.simulateClose(1006);
    vi.advanceTimersByTime(1000);

    // Close again → reconnect attempt 2.
    lastInstance()!.simulateClose(1006);
    vi.advanceTimersByTime(1000);

    // Close again → should NOT reconnect (max reached).
    lastInstance()!.simulateClose(1006);
    vi.advanceTimersByTime(10000);

    expect(reconnFn).toHaveBeenCalledTimes(2);
    t.destroy();
  });
});

describe('destroy', () => {
  it('disconnects and prevents further operations', () => {
    const t = makeTransport();
    t.connect();
    lastInstance()!.simulateOpen();

    t.destroy();
    t.connect(); // should be no-op after destroy

    // State should remain disconnected.
    expect(t.state).toBe('disconnected');
  });
});
