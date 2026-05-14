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
    code:            'code',
    description:     'desc',
    payload:         'data',
    body:            'data',
  },
  codes: {
    success:         'OK',
    interim:         'PENDING',
    error:           ['ERROR'],
  },
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
  });

  it('sends encoded JSON with msgId when includeIdInRequest=true', () => {
    const protocol = { ...TEST_PROTOCOL, includeIdInRequest: true };
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol,
      reconnect: false,
    });
    t.connect();
    lastInstance()!.simulateOpen();

    t.send({ channel: 'ping' });

    const ws = lastInstance()!;
    expect(ws.sent.length).toBe(1);
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.channel).toBe('ping');
    expect(typeof parsed.msgId).toBe('number');
    t.destroy();
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
    ws.simulateMessage({ channel: 'ping', msgId: 0, code: 'OK', desc: '', data: {} });

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

  it('routes messages with no channel but valid messageId via ID-only fallback', async () => {
    const protocol = {
      ...TEST_PROTOCOL,
      includeIdInRequest: true,
    };
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol,
      reconnect: false,
    });
    t.connect();
    const ws = lastInstance()!;
    ws.simulateOpen();

    // Send a request so an ephemeral handler is registered.
    const promise = t.request({ channel: 'market_subscribe' });
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    const msgId = sent.msgId;

    // Response arrives with no channel, only the echoed msgId.
    ws.simulateMessage({
      msgId,
      code: 'OK',
      desc: 'subscribed',
      data: { status: 'success' },
    });

    const res = await promise;
    expect(res.code).toBe('OK');
    expect(res.data).toEqual({ status: 'success' });
    t.destroy();
  });

  it('drops messages with no channel AND no messageId', () => {
    const t = makeTransport();
    const fn = vi.fn();
    t.on('message:unhandled', fn);
    t.on('message:parsed', fn);

    t.connect();
    const ws = lastInstance()!;
    ws.simulateOpen();
    ws.simulateMessage({
      code: 'OK',
      desc: '',
      data: {},
    });

    // With the '*' wildcard fallback, channel-less messages now resolve
    // to '*' and pass through the gate. They reach handlers but since
    // nothing is registered on '*', they end up as unhandled.
    // Events: message:parsed + message:unhandled = 2.
    expect(fn).toHaveBeenCalledTimes(2);
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

describe('WebSocket constructor failure', () => {
  it('emits error and schedules reconnect when WebSocket constructor throws', () => {
    // Override mock to throw on construction.
    const original = globalThis.WebSocket;
    let throwNext = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = class {
      constructor() {
        if (throwNext) throw new Error('Network unreachable');
      }
    };

    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: TEST_PROTOCOL,
      reconnect: { auto: true, delayMs: 1000, backoff: 'fixed' },
    });

    const errorFn = vi.fn();
    const reconnFn = vi.fn();
    t.on('error', errorFn);
    t.on('reconnecting', reconnFn);

    t.connect();

    expect(errorFn).toHaveBeenCalledTimes(1);
    expect(reconnFn).toHaveBeenCalledTimes(1);

    // Restore before next test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = original;
    t.destroy();
  });
});

describe('send failure auto-reconnect', () => {
  it('schedules reconnect when send is called with a CLOSED socket', () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: TEST_PROTOCOL,
      reconnect: { auto: true, delayMs: 1000, backoff: 'fixed' },
    });

    const reconnFn = vi.fn();
    t.on('reconnecting', reconnFn);

    t.connect();
    const ws = lastInstance()!;
    ws.simulateOpen();

    // Force socket to CLOSED state without triggering onClose-driven reconnect.
    ws.readyState = 3; // WS_CLOSED

    const errorFn = vi.fn();
    t.on('send:error', errorFn);

    t.send({ channel: 'ping' });

    expect(errorFn).toHaveBeenCalledTimes(1);

    // Advance past the 1s send-failure reconnect delay.
    vi.advanceTimersByTime(1100);

    // A new WebSocket should have been created.
    expect(lastInstance()!.url).toBe('ws://test.local/ws');
    t.destroy();
  });
});

describe('dynamic URL', () => {
  it('evaluates URL function lazily on each connect', () => {
    let callCount = 0;
    const urlFn = vi.fn(() => {
      callCount++;
      return `ws://test.local/ws?v=${callCount}`;
    });

    const t = createTransport({
      url: urlFn,
      protocol: TEST_PROTOCOL,
      reconnect: false,
    });

    t.connect();
    expect(urlFn).toHaveBeenCalledTimes(1);
    expect(lastInstance()!.url).toBe('ws://test.local/ws?v=1');

    // Disconnect and reconnect — URL function called again.
    lastInstance()!.simulateOpen();
    t.disconnect();
    t.connect();
    expect(urlFn).toHaveBeenCalledTimes(2);
    expect(lastInstance()!.url).toBe('ws://test.local/ws?v=2');

    t.destroy();
  });
});

describe('decode failure', () => {
  it('silently drops messages when decode returns null', () => {
    const protocol = {
      ...TEST_PROTOCOL,
      decode: (_raw: string) => null, // always fails
    };
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol,
      reconnect: false,
    });

    const parsedFn = vi.fn();
    const unhandledFn = vi.fn();
    t.on('message:parsed', parsedFn);
    t.on('message:unhandled', unhandledFn);

    t.connect();
    const ws = lastInstance()!;
    ws.simulateOpen();
    ws.simulateMessage({ channel: 'test', msgId: 0, code: 'OK', desc: '', data: {} });

    // Neither event should fire — message dropped silently.
    expect(parsedFn).not.toHaveBeenCalled();
    expect(unhandledFn).not.toHaveBeenCalled();

    t.destroy();
  });
});
