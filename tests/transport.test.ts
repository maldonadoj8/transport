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

/** Protocol with includeIdInRequest for tests that need to read msgId from the wire. */
const PROTOCOL_WITH_ID: ProtocolSchema = {
  ...TEST_PROTOCOL,
  includeIdInRequest: true,
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

describe('send()', () => {
  it('does not include messageId on wire by default', () => {
    const t = connected();
    t.send({ channel: 'ping' });

    const ws = lastInstance()!;
    const parsed = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(parsed.channel).toBe('ping');
    expect(parsed).not.toHaveProperty('msgId');
    t.destroy();
  });

  it('includes messageId on wire when includeIdInRequest=true', () => {
    const t = connected({
      protocol: { ...TEST_PROTOCOL, includeIdInRequest: true },
    });
    t.send({ channel: 'ping' });

    const ws = lastInstance()!;
    const parsed = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(parsed.channel).toBe('ping');
    expect(typeof parsed.msgId).toBe('number');
    t.destroy();
  });

  it('flattens data with opts.flattenOutgoing=true overriding schema default of false', () => {
    const t = connected({
      protocol: { ...TEST_PROTOCOL, flattenOutgoing: false },
    });
    t.send({ channel: 'x', data: { a: 1 } }, { flattenOutgoing: true });

    const ws = lastInstance()!;
    const parsed = JSON.parse(ws.sent[ws.sent.length - 1]);
    // data key 'a' should be on root, NOT nested under 'data'
    expect(parsed.a).toBe(1);
    expect(parsed).not.toHaveProperty('data');
    t.destroy();
  });

  it('nests data with opts.flattenOutgoing=false overriding schema default of true', () => {
    const t = connected(); // TEST_PROTOCOL has flattenOutgoing: true
    t.send({ channel: 'x', data: { a: 1 } }, { flattenOutgoing: false });

    const ws = lastInstance()!;
    const parsed = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(parsed.data).toEqual({ a: 1 });
    expect(parsed).not.toHaveProperty('a');
    t.destroy();
  });
});

describe('request()', () => {
  it('resolves on success response', async () => {
    const t = connected({
      protocol: PROTOCOL_WITH_ID,
    });

    const promise = t.request({ channel: 'usuario', data: { id: 5 } });
    const msgId = lastSentId();

    // Simulate server response.
    lastInstance()!.simulateMessage({
      channel: 'usuario',
      msgId,
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
    const t = connected({
      protocol: PROTOCOL_WITH_ID,
    });

    const promise = t.request({ channel: 'usuario', data: { id: 999 } });
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'usuario',
      msgId,
      code: 'ERROR',
      desc: 'Not found',
      data: {},
    });

    await expect(promise).rejects.toMatchObject({ code: 'ERROR', response: { description: 'Not found' } });
    t.destroy();
  });

  it('handles interim response without resolving', async () => {
    const t = connected({
      protocol: PROTOCOL_WITH_ID,
    });

    const promise = t.request({ channel: 'proceso' });
    const msgId = lastSentId();
    const ws = lastInstance()!;

    // Interim response.
    ws.simulateMessage({
      channel: 'proceso',
      msgId,
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
      code: 'OK',
      desc: 'Done',
      data: { resultado: true },
    });

    const res = await promise;
    expect(res.code).toBe('OK');
    t.destroy();
  });

  it('resolves via ID-only fallback when response has no channel', async () => {
    const t = connected({
      protocol: { ...TEST_PROTOCOL, includeIdInRequest: true },
    });

    const promise = t.request({ channel: 'market_subscribe' });
    const ws = lastInstance()!;
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    const msgId = sent.msgId;

    // Server responds with only the ID, no channel field.
    ws.simulateMessage({
      msgId,
      code: 'OK',
      desc: 'ok',
      data: { status: 'success' },
    });

    const res = await promise;
    expect(res.code).toBe('OK');
    expect(res.data).toEqual({ status: 'success' });
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

  it('nests data with opts.flattenOutgoing=false overriding schema default of true', async () => {
    const t = connected({ protocol: PROTOCOL_WITH_ID }); // flattenOutgoing: true
    const promise = t.request(
      { channel: 'usuario', data: { id: 5 } },
      { flattenOutgoing: false },
    );

    const ws = lastInstance()!;
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    // data should be nested under 'data' field, not spread onto root
    expect(sent.data).toEqual({ id: 5 });
    expect(sent).not.toHaveProperty('id');

    // resolve so the promise doesn't dangle
    const msgId = sent.msgId;
    ws.simulateMessage({ channel: 'usuario', msgId, code: 'OK', desc: '', data: {} });
    await promise;
    t.destroy();
  });

  it('flattens data with opts.flattenOutgoing=true overriding schema default of false', async () => {
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, flattenOutgoing: false },
    });
    const promise = t.request(
      { channel: 'usuario', data: { id: 5 } },
      { flattenOutgoing: true },
    );

    const ws = lastInstance()!;
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(sent.id).toBe(5);
    expect(sent).not.toHaveProperty('data');

    const msgId = sent.msgId;
    ws.simulateMessage({ channel: 'usuario', msgId, code: 'OK', desc: '', data: {} });
    await promise;
    t.destroy();
  });
});

describe('request() codes variations', () => {
  it('resolves all responses when codes is omitted', async () => {
    const { codes: _, ...protocolNoCodes } = { ...PROTOCOL_WITH_ID };
    const t = connected({
      protocol: protocolNoCodes as ProtocolSchema,
    });

    const promise = t.request({ channel: 'test' });
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'test',
      msgId,
      code: 'ANYTHING',
      desc: '',
      data: { ok: true },
    });

    const res = await promise;
    expect(res.code).toBe('ANYTHING');
    expect(res.data).toEqual({ ok: true });
    t.destroy();
  });

  it('resolves all responses when codes is empty object', async () => {
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, codes: {} },
    });

    const promise = t.request({ channel: 'test' });
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'test',
      msgId,
      code: 'WHATEVER',
      desc: '',
      data: {},
    });

    const res = await promise;
    expect(res.code).toBe('WHATEVER');
    t.destroy();
  });

  it('rejects when error codes include the response code', async () => {
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, codes: { error: ['ERR', 'AUTH_ERR', 'RATE_LIMIT'] } },
    });

    const promise = t.request({ channel: 'test' });
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'test',
      msgId,
      code: 'AUTH_ERR',
      desc: 'Unauthorized',
      data: {},
    });

    await expect(promise).rejects.toMatchObject({ code: 'AUTH_ERR', response: { description: 'Unauthorized' } });
    t.destroy();
  });

  it('resolves non-error responses when only error is defined (no success)', async () => {
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, codes: { error: ['ERR'] } },
    });

    const promise = t.request({ channel: 'test' });
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'test',
      msgId,
      code: 'SOMETHING_ELSE',
      desc: '',
      data: { ok: true },
    });

    const res = await promise;
    expect(res.data).toEqual({ ok: true });
    t.destroy();
  });

  it('rejects unknown code when success is defined but does not match', async () => {
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, codes: { success: 'OK' } },
    });

    const promise = t.request({ channel: 'test' });
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'test',
      msgId,
      code: 'UNKNOWN',
      desc: '',
      data: {},
    });

    await expect(promise).rejects.toMatchObject({ code: 'UNKNOWN' });
    t.destroy();
  });

  it('interim is ignored when not defined in codes', async () => {
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, codes: { success: 'OK' } },
    });

    const promise = t.request({ channel: 'test' });
    const msgId = lastSentId();

    // A message with code 'PENDING' should NOT be treated as interim
    // since codes.interim is undefined — it should reject (unknown code).
    lastInstance()!.simulateMessage({
      channel: 'test',
      msgId,
      code: 'PENDING',
      desc: '',
      data: {},
    });

    await expect(promise).rejects.toMatchObject({ code: 'PENDING' });
    t.destroy();
  });
});

describe('fire()', () => {
  it('calls callback on response', () => {
    const t = connected({
      protocol: PROTOCOL_WITH_ID,
    });
    const fn = vi.fn();

    t.fire({ channel: 'ping' }, fn);
    const msgId = lastSentId();

    lastInstance()!.simulateMessage({
      channel: 'ping',
      msgId,
      code: 'OK',
      desc: 'pong',
      data: {},
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].code).toBe('OK');
    t.destroy();
  });

  it('returns unsubscribe function', () => {
    const t = connected({
      protocol: PROTOCOL_WITH_ID,
    });
    const fn = vi.fn();

    const unsub = t.fire({ channel: 'test' }, fn);
    unsub();

    const msgId = lastSentId();
    lastInstance()!.simulateMessage({
      channel: 'test',
      msgId,
      code: 'OK',
      desc: '',
      data: {},
    });

    expect(fn).not.toHaveBeenCalled();
    t.destroy();
  });

  it('nests data with opts.flattenOutgoing=false overriding schema default of true', () => {
    const t = connected({ protocol: PROTOCOL_WITH_ID }); // flattenOutgoing: true
    t.fire({ channel: 'x', data: { a: 1 } }, vi.fn(), { flattenOutgoing: false });

    const ws = lastInstance()!;
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(sent.data).toEqual({ a: 1 });
    expect(sent).not.toHaveProperty('a');
    t.destroy();
  });

  it('flattens data with opts.flattenOutgoing=true overriding schema default of false', () => {
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, flattenOutgoing: false },
    });
    t.fire({ channel: 'x', data: { a: 1 } }, vi.fn(), { flattenOutgoing: true });

    const ws = lastInstance()!;
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(sent.a).toBe(1);
    expect(sent).not.toHaveProperty('data');
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
      code: 'OK',
      desc: '',
      data: { entrega: [{ id: 1 }] },
    });

    expect(fn).toHaveBeenCalledTimes(1);

    // Second push.
    lastInstance()!.simulateMessage({
      channel: 'entrega',
      msgId: 0,
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
      channel: 'x', msgId: 0, code: 'OK', desc: '', data: {},
    });

    expect(fn).not.toHaveBeenCalled();
    t.destroy();
  });
});

describe('protocol', () => {
  it('exposes read-only protocol on transport', () => {
    const t = connected();
    expect(t.protocol).toBe(t.protocol); // same reference
    expect(t.protocol.fields.requestChannel).toBe('channel');
    t.destroy();
  });
});

// ======================== channel-less protocol ==============================

describe('channel-less protocol', () => {
  /** Protocol with no requestChannel / responseChannel — like WhiteBit. */
  const CHANNELLESS_PROTOCOL: ProtocolSchema = {
    fields: {
      messageId: 'id',
      code:      'status',
      error:     'error',
      payload:   'params',
      body:      'result',
    },
    codes: {
      success: undefined,
      error:   ['ERROR'],
    },
    generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
    encode: (msg) => JSON.stringify(msg),
    decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
    flattenOutgoing: false,
    includeIdInRequest: true,
  };

  function connectedChannelless(): Transport {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: CHANNELLESS_PROTOCOL,
      reconnect: false,
    });
    t.connect();
    lastInstance()!.simulateOpen();
    return t;
  }

  it('request() works without channel fields', async () => {
    const t = connectedChannelless();
    const ws = lastInstance()!;

    const promise = t.request({ data: { method: 'ping' } });

    // Read the sent message to extract the ID.
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    const msgId = sent.id;

    // Simulate response — no channel field, just id + result.
    ws.simulateMessage({ id: msgId, status: null, error: null, result: { pong: true } });

    const res = await promise;
    expect(res.channel).toBe('*');
    expect(res.messageId).toBe(msgId);
    expect(res.data).toEqual({ pong: true });
    t.destroy();
  });

  it('fire() works without channel fields', () => {
    const t = connectedChannelless();
    const ws = lastInstance()!;
    const fn = vi.fn();

    t.fire({ data: { method: 'time' } }, fn);

    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    const msgId = sent.id;

    ws.simulateMessage({ id: msgId, result: { time: 12345 } });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].channel).toBe('*');
    t.destroy();
  });

  it('send() builds wire message with no channel key', () => {
    const t = connectedChannelless();
    const ws = lastInstance()!;

    t.send({ data: { method: 'subscribe', params: ['BTC_USDT'] } });

    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(sent).toHaveProperty('id');
    expect(sent).toHaveProperty('params');
    // No channel-like key should exist.
    expect(sent).not.toHaveProperty('channel');
    expect(sent).not.toHaveProperty('action');
    t.destroy();
  });

  it('request() rejects on error code in channel-less protocol', async () => {
    const t = connectedChannelless();
    const ws = lastInstance()!;

    const promise = t.request({ data: { method: 'bad' } });
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);

    ws.simulateMessage({ id: sent.id, status: 'ERROR', error: 'Not found', result: {} });

    await expect(promise).rejects.toMatchObject({ code: 'ERROR', error: 'Not found' });
    t.destroy();
  });

  it('addHandler on * receives channel-less pushes', () => {
    const t = connectedChannelless();
    const ws = lastInstance()!;
    const fn = vi.fn();

    t.addHandler('*', 'push-listener', fn);
    // Simulate a spontaneous push with no channel and id=0.
    ws.simulateMessage({ id: 0, result: { event: 'update' } });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].channel).toBe('*');
    t.destroy();
  });
});

// ======================== request() edge cases ================================

describe('request() edge cases', () => {
  it('timeout:0 means no timeout — request waits indefinitely', async () => {
    const t = connected({ protocol: PROTOCOL_WITH_ID });
    const promise = t.request({ channel: 'slow' }, { timeout: 0 });

    // Advance far into the future — promise should still be pending.
    vi.advanceTimersByTime(999_999);
    let settled = false;
    promise.then(() => { settled = true; }).catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    // Now resolve it normally.
    const msgId = lastSentId();
    lastInstance()!.simulateMessage({ channel: 'slow', msgId, code: 'OK', desc: '', data: {} });
    const res = await promise;
    expect(res.code).toBe('OK');
    t.destroy();
  });

  it('interim response does not reset the timeout counter', async () => {
    const t = connected({ protocol: PROTOCOL_WITH_ID });
    const promise = t.request({ channel: 'proceso' }, { timeout: 5000 });
    const msgId = lastSentId();

    // Send interim at t=3000ms (before timeout).
    vi.advanceTimersByTime(3000);
    lastInstance()!.simulateMessage({
      channel: 'proceso', msgId, code: 'PENDING', desc: '', data: {},
    });

    // Advance past the original timeout deadline (3000+2001 = 5001ms total).
    vi.advanceTimersByTime(2001);

    // The original timer was set at t=0 for 5000ms, interim does not reset it.
    await expect(promise).rejects.toThrow('Request timeout after 5000ms');
    t.destroy();
  });

  it('disconnect() while request is pending rejects the promise', async () => {
    const t = connected({ protocol: PROTOCOL_WITH_ID });
    const p1 = t.request({ channel: 'a' });
    const p2 = t.request({ channel: 'b' });

    t.disconnect();
    // Flush microtask queue.
    await vi.advanceTimersByTimeAsync(0);

    // Both promises should settle (timeout or connection error).
    // Advance past default timeout to ensure they reject.
    vi.advanceTimersByTime(30_001);
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
    t.destroy();
  });

  it('rejects when generateId exhausts all retries', async () => {
    // Deterministic generator that always returns 1.
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, generateId: () => 1 },
    });

    // Register one ephemeral handler for id=1 on channel 'x'. Since generateId
    // always returns 1, every retry attempt collides with this single entry,
    // saturating the retry loop.
    t.fire({ channel: 'x' }, vi.fn());

    await expect(t.request({ channel: 'x' })).rejects.toThrow(
      'Failed to generate a unique message ID',
    );
    t.destroy();
  });

  it('rejects when generateId always returns 0 (reserved for server pushes)', async () => {
    const t = connected({
      protocol: { ...PROTOCOL_WITH_ID, generateId: () => 0 },
    });

    await expect(t.request({ channel: 'x' })).rejects.toThrow(
      'Failed to generate a unique message ID',
    );
    t.destroy();
  });
});

// ======================== auto-reconnect backoff ==============================

describe('auto-reconnect exponential backoff', () => {
  it('doubles delay between reconnect attempts', () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: TEST_PROTOCOL,
      reconnect: { auto: true, delayMs: 1000, backoff: 'exponential' },
    });

    const delays: number[] = [];
    t.on('reconnecting', ({ delayMs }) => delays.push(delayMs));

    t.connect();
    lastInstance()!.simulateOpen();

    // Attempt 1 — delay = 1000 * 2^0 = 1000ms.
    lastInstance()!.simulateClose(1006);
    vi.advanceTimersByTime(1000);

    // Attempt 2 — delay = 1000 * 2^1 = 2000ms.
    lastInstance()!.simulateClose(1006);
    vi.advanceTimersByTime(2000);

    // Attempt 3 — delay = 1000 * 2^2 = 4000ms.
    lastInstance()!.simulateClose(1006);
    vi.advanceTimersByTime(4000);

    expect(delays).toEqual([1000, 2000, 4000]);
    t.destroy();
  });

  it('caps exponential backoff at 60s', () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: TEST_PROTOCOL,
      reconnect: { auto: true, delayMs: 10_000, backoff: 'exponential' },
    });

    const delays: number[] = [];
    t.on('reconnecting', ({ delayMs }) => delays.push(delayMs));

    t.connect();
    lastInstance()!.simulateOpen();

    // Simulate many failures to push past the 60s cap.
    // 10000 * 2^3 = 80000 → capped at 60000.
    for (let i = 0; i < 4; i++) {
      lastInstance()!.simulateClose(1006);
      vi.advanceTimersByTime(60_001);
    }

    // All delays after the cap should be exactly 60000.
    const capped = delays.filter(d => d >= 60_000);
    expect(capped.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBe(60_000);
    t.destroy();
  });
});
