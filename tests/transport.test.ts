// =============================================================================
// Tests: transport.ts (request, fire, send)
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installMock, lastInstance } from './__mocks__/ws.js';
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

function connected(overrides?: Partial<Parameters<typeof createTransport>[0]>): Transport {
  const t = createTransport({
    url: 'ws://test.local/ws',
    protocol: TEST_PROTOCOL,
    reconnect: false,
    ...overrides,
  });
  t.connect();
  lastInstance()!.simulateOpen();
  return t;
}

// Helper: extract messageId from the last sent message.
function lastSentId(): number {
  const ws = lastInstance()!;
  const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
  return msg.msgId;
}

describe('createTransport', () => {
  it('creates transport with provided protocol', () => {
    const t = createTransport({ url: 'ws://x', protocol: TEST_PROTOCOL, reconnect: false });
    expect(t.protocol.fields.requestChannel).toBe('channel');
    expect(t.state).toBe('disconnected');
    t.destroy();
  });

  it('creates transport with custom field names', () => {
    const customProtocol: ProtocolSchema = {
      ...TEST_PROTOCOL,
      fields: { ...TEST_PROTOCOL.fields, requestChannel: 'action', responseChannel: 'action' },
      flattenOutgoing: false,
    };
    const t = createTransport({
      url: 'ws://x',
      protocol: customProtocol,
      reconnect: false,
    });
    expect(t.protocol.fields.requestChannel).toBe('action');
    expect(t.protocol.flattenOutgoing).toBe(false);
    t.destroy();
  });
});

describe('request()', () => {
  it('resolves on success response', async () => {
    const t = connected();

    const promise = t.request({ channel: 'usuario', data: { id: 5 } });
    const msgId = lastSentId();

    // Simulate server response.
    lastInstance()!.simulateMessage({
      channel: 'usuario',
      msgId,
      type: 1,
      code: 'OK',
      desc: 'Success',
      data: { usuario: [{ id: 5, nombre: 'Ana' }] },
    });

    const res = await promise;
    expect(res.code).toBe('OK');
    expect(res.data).toEqual({ usuario: [{ id: 5, nombre: 'Ana' }] });
    t.destroy();
  });

  it('rejects on failure response', async () => {
    const t = connected();

    const promise = t.request({ channel: 'usuario', data: { id: 999 } });
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'usuario',
      msgId,
      type: 2,
      code: 'ERROR',
      desc: 'Not found',
      data: {},
    });

    await expect(promise).rejects.toMatchObject({ code: 'ERROR', description: 'Not found' });
    t.destroy();
  });

  it('handles interim response without resolving', async () => {
    const t = connected();

    const promise = t.request({ channel: 'proceso' });
    const msgId = lastSentId();
    const ws = lastInstance()!;

    // Interim response.
    ws.simulateMessage({
      channel: 'proceso',
      msgId,
      type: 4,
      code: 'PENDING',
      desc: 'Processing...',
      data: {},
    });

    // Promise should still be pending...
    let resolved = false;
    promise.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);

    // Final response.
    ws.simulateMessage({
      channel: 'proceso',
      msgId,
      type: 1,
      code: 'OK',
      desc: 'Done',
      data: { resultado: true },
    });

    const res = await promise;
    expect(res.code).toBe('OK');
    t.destroy();
  });

  it('rejects on timeout', async () => {
    const t = connected();

    const promise = t.request(
      { channel: 'slow' },
      { timeout: 5000 },
    );

    vi.advanceTimersByTime(5000);

    await expect(promise).rejects.toThrow('Request timeout after 5000ms');
    t.destroy();
  });
});

describe('fire()', () => {
  it('calls callback on response', () => {
    const t = connected();
    const fn = vi.fn();

    t.fire({ channel: 'ping' }, fn);
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'ping',
      msgId,
      type: 1,
      code: 'OK',
      desc: 'pong',
      data: {},
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].code).toBe('OK');
    t.destroy();
  });

  it('returns unsubscribe function', () => {
    const t = connected();
    const fn = vi.fn();

    const unsub = t.fire({ channel: 'test' }, fn);
    unsub();

    const msgId = lastSentId();
    lastInstance()!.simulateMessage({
      channel: 'test',
      msgId,
      type: 1,
      code: 'OK',
      desc: '',
      data: {},
    });

    expect(fn).not.toHaveBeenCalled();
    t.destroy();
  });
});

describe('addHandler / removeHandler', () => {
  it('persistent handler receives server pushes', () => {
    const t = connected();
    const fn = vi.fn();
    t.addHandler('entrega', 'sync', fn);

    // Spontaneous push (msgId = 0).
    lastInstance()!.simulateMessage({
      channel: 'entrega',
      msgId: 0,
      type: 1,
      code: 'OK',
      desc: '',
      data: { entrega: [{ id: 1 }] },
    });

    expect(fn).toHaveBeenCalledTimes(1);

    // Second push.
    lastInstance()!.simulateMessage({
      channel: 'entrega',
      msgId: 0,
      type: 1,
      code: 'OK',
      desc: '',
      data: { entrega: [{ id: 2 }] },
    });

    expect(fn).toHaveBeenCalledTimes(2);
    t.destroy();
  });

  it('removeHandler stops receiving', () => {
    const t = connected();
    const fn = vi.fn();
    t.addHandler('entrega', 'sync', fn);
    t.removeHandler('entrega', 'sync');

    lastInstance()!.simulateMessage({
      channel: 'entrega',
      msgId: 0,
      type: 1,
      code: 'OK',
      desc: '',
      data: {},
    });

    expect(fn).not.toHaveBeenCalled();
    t.destroy();
  });

  it('addHandler returns unsubscribe function', () => {
    const t = connected();
    const fn = vi.fn();
    const unsub = t.addHandler('x', 'y', fn);
    unsub();

    lastInstance()!.simulateMessage({
      channel: 'x', msgId: 0, type: 1, code: 'OK', desc: '', data: {},
    });

    expect(fn).not.toHaveBeenCalled();
    t.destroy();
  });
});

describe('protocol', () => {
  it('exposes read-only protocol on transport', () => {
    const t = connected();
    expect(t.protocol).toBe(t.protocol); // same reference
    expect(t.protocol.responseTypes.all).toBe(15);
    t.destroy();
  });
});
