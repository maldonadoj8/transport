// =============================================================================
// Integration Tests — full transport lifecycle
//
// End-to-end scenarios using the MockWebSocket. Each test exercises a
// complete interaction cycle from connect → send → receive → teardown.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installMock, lastInstance } from '../__mocks__/ws.js';
import { createTransport } from '../../src/transport.js';
import type { ProtocolSchema, TransportError } from '../../src/types.js';

let restore: () => void;

beforeEach(() => {
  restore = installMock();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  restore();
});

// ======================== PROTOCOLS ==========================================

/** Standard channel-based protocol (e.g. internal REST-over-WS APIs). */
const CHANNEL_PROTOCOL: ProtocolSchema = {
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
    success: 'OK',
    interim: 'PENDING',
    error:   ['ERROR'],
  },
  generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
  encode: (msg) => JSON.stringify(msg),
  decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  flattenOutgoing: true,
  includeIdInRequest: true,
};

/** Channel-less protocol (e.g. WhiteBit / Binance style — routing by ID only). */
const CHANNELLESS_PROTOCOL: ProtocolSchema = {
  fields: {
    messageId: 'id',
    code:      'status',
    error:     'error',
    payload:   'params',
    body:      'result',
  },
  codes: {
    error: ['ERROR'],
  },
  generateId: () => Math.floor(Math.random() * 1_000_000_000) + 1,
  encode: (msg) => JSON.stringify(msg),
  decode: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  flattenOutgoing: false,
  includeIdInRequest: true,
};

// ======================== HELPERS ============================================

function connect(protocol = CHANNEL_PROTOCOL) {
  const t = createTransport({
    url: 'ws://test.local/ws',
    protocol,
    reconnect: false,
  });
  t.connect();
  lastInstance()!.simulateOpen();
  return t;
}

function lastSentId(): number {
  const ws = lastInstance()!;
  const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
  return msg.msgId ?? msg.id;
}

// ======================== SCENARIOS ==========================================

describe('Scenario 1: Full request/response lifecycle', () => {
  it('connects, sends a request, receives a response, and resolves', async () => {
    const t = connect();
    const ws = lastInstance()!;

    expect(t.state).toBe('connected');

    const promise = t.request({ channel: 'getUser', data: { id: 5 } });
    const msgId = lastSentId();

    // Verify the wire message was built correctly.
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(sent.channel).toBe('getUser');
    expect(sent.msgId).toBe(msgId);
    expect(sent.id).toBe(5);

    // Server responds.
    ws.simulateMessage({
      channel: 'getUser',
      msgId,
      code: 'OK',
      desc: 'Success',
      data: { user: { id: 5, name: 'Ana' } },
    });

    const res = await promise;
    expect(res.channel).toBe('getUser');
    expect(res.code).toBe('OK');
    expect(res.data).toEqual({ user: { id: 5, name: 'Ana' } });

    t.destroy();
  });
});

describe('Scenario 2: Interim → final response', () => {
  it('resolves only on the final response after one or more interim responses', async () => {
    const t = connect();
    const ws = lastInstance()!;

    const resolveSpy = vi.fn();
    const promise = t.request({ channel: 'longProcess' });
    promise.then(resolveSpy);
    const msgId = lastSentId();

    // First interim.
    ws.simulateMessage({ channel: 'longProcess', msgId, code: 'PENDING', desc: '10%', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveSpy).not.toHaveBeenCalled();

    // Second interim.
    ws.simulateMessage({ channel: 'longProcess', msgId, code: 'PENDING', desc: '50%', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveSpy).not.toHaveBeenCalled();

    // Final response.
    ws.simulateMessage({ channel: 'longProcess', msgId, code: 'OK', desc: 'Done', data: { result: true } });
    const res = await promise;
    expect(res.code).toBe('OK');
    expect(res.data).toEqual({ result: true });

    t.destroy();
  });
});

describe('Scenario 3: Server push to persistent handler', () => {
  it('persistent handler fires on each server-initiated push', () => {
    const t = connect();
    const ws = lastInstance()!;

    const handler = vi.fn();
    t.addHandler('orderUpdate', 'sync', handler);

    // Simulate two spontaneous server pushes (msgId=0).
    ws.simulateMessage({ channel: 'orderUpdate', msgId: 0, code: 'OK', desc: '', data: { orderId: 1 } });
    ws.simulateMessage({ channel: 'orderUpdate', msgId: 0, code: 'OK', desc: '', data: { orderId: 2 } });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].data).toEqual({ orderId: 1 });
    expect(handler.mock.calls[1][0].data).toEqual({ orderId: 2 });

    t.destroy();
  });

  it('persistent handler stops firing after removeHandler', () => {
    const t = connect();
    const ws = lastInstance()!;

    const handler = vi.fn();
    t.addHandler('orderUpdate', 'sync', handler);

    ws.simulateMessage({ channel: 'orderUpdate', msgId: 0, code: 'OK', desc: '', data: { orderId: 1 } });
    expect(handler).toHaveBeenCalledTimes(1);

    t.removeHandler('orderUpdate', 'sync');
    ws.simulateMessage({ channel: 'orderUpdate', msgId: 0, code: 'OK', desc: '', data: { orderId: 2 } });
    expect(handler).toHaveBeenCalledTimes(1); // no new calls

    t.destroy();
  });
});

describe('Scenario 4: Request timeout', () => {
  it('rejects with timeout error when server never responds', async () => {
    const t = connect();

    const promise = t.request({ channel: 'slow' }, { timeout: 3000 });

    vi.advanceTimersByTime(3000);

    await expect(promise).rejects.toThrow('Request timeout after 3000ms: slow');

    t.destroy();
  });

  it('timeout rejection provides the channel name in the message', async () => {
    const t = connect();

    const promise = t.request({ channel: 'getUserProfile' }, { timeout: 1000 });
    vi.advanceTimersByTime(1000);

    try {
      await promise;
    } catch (err) {
      expect((err as Error).message).toContain('getUserProfile');
    }

    t.destroy();
  });
});

describe('Scenario 5: Reconnect and resume', () => {
  it('reconnects after connection drop and new request succeeds', async () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: CHANNEL_PROTOCOL,
      reconnect: { auto: true, delayMs: 500, backoff: 'fixed' },
    });

    const reconnFn = vi.fn();
    t.on('reconnecting', reconnFn);

    t.connect();
    lastInstance()!.simulateOpen();
    expect(t.state).toBe('connected');

    // Server drops the connection.
    lastInstance()!.simulateClose(1006, 'server reset');
    expect(reconnFn).toHaveBeenCalledTimes(1);

    // Advance to trigger reconnect.
    vi.advanceTimersByTime(500);

    // New WebSocket was created — simulate open.
    lastInstance()!.simulateOpen();
    expect(t.state).toBe('connected');

    // New request on the fresh connection.
    const promise = t.request({ channel: 'ping' });
    const msgId = lastSentId();
    lastInstance()!.simulateMessage({ channel: 'ping', msgId, code: 'OK', desc: '', data: { pong: true } });

    const res = await promise;
    expect(res.data).toEqual({ pong: true });

    t.destroy();
  });
});

describe('Scenario 6: fire() vs request() with interim', () => {
  it('fire() receives all messages including interim; request() resolves only on final', async () => {
    const t = connect();
    const ws = lastInstance()!;

    // fire() — receives every message.
    const fireMessages: string[] = [];
    t.fire({ channel: 'multi' }, (msg) => {
      fireMessages.push(msg.code);
      // Return false on interim to keep the handler alive.
      return msg.code !== 'PENDING' ? true : false;
    });
    const fireMsgId = lastSentId();

    // request() — resolves only on final.
    const requestPromise = t.request({ channel: 'multi' });
    const requestMsgId = lastSentId();

    // Send interim to both.
    ws.simulateMessage({ channel: 'multi', msgId: fireMsgId,    code: 'PENDING', desc: '', data: {} });
    ws.simulateMessage({ channel: 'multi', msgId: requestMsgId, code: 'PENDING', desc: '', data: {} });

    await vi.advanceTimersByTimeAsync(0);
    expect(fireMessages).toContain('PENDING');

    let requestResolved = false;
    requestPromise.then(() => { requestResolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestResolved).toBe(false); // still pending

    // Final response.
    ws.simulateMessage({ channel: 'multi', msgId: fireMsgId,    code: 'OK', desc: '', data: { done: true } });
    ws.simulateMessage({ channel: 'multi', msgId: requestMsgId, code: 'OK', desc: '', data: { done: true } });

    expect(fireMessages).toContain('OK');

    const res = await requestPromise;
    expect(res.code).toBe('OK');

    t.destroy();
  });
});

describe('Scenario 7: Channel-less protocol (ID-only routing)', () => {
  it('routes responses by ID only when no channel fields defined', async () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: CHANNELLESS_PROTOCOL,
      reconnect: false,
    });
    t.connect();
    lastInstance()!.simulateOpen();
    const ws = lastInstance()!;

    const promise = t.request({ data: { method: 'ping', params: [] } });
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    const msgId = sent.id;

    // Response has no channel — only the ID.
    ws.simulateMessage({ id: msgId, status: null, error: null, result: { pong: 1 } });

    const res = await promise;
    expect(res.channel).toBe('*');
    expect(res.data).toEqual({ pong: 1 });

    t.destroy();
  });

  it('wildcard * handler receives spontaneous pushes in channel-less protocol', () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: CHANNELLESS_PROTOCOL,
      reconnect: false,
    });
    t.connect();
    lastInstance()!.simulateOpen();
    const ws = lastInstance()!;

    const handler = vi.fn();
    t.addHandler('*', 'push', handler);

    // Server push: id=0, no channel.
    ws.simulateMessage({ id: 0, result: { event: 'priceUpdate', price: '100.00' } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].channel).toBe('*');
    expect(handler.mock.calls[0][0].data).toEqual({ event: 'priceUpdate', price: '100.00' });

    t.destroy();
  });

  it('rejects request on error code in channel-less protocol', async () => {
    const t = createTransport({
      url: 'ws://test.local/ws',
      protocol: CHANNELLESS_PROTOCOL,
      reconnect: false,
    });
    t.connect();
    lastInstance()!.simulateOpen();
    const ws = lastInstance()!;

    const promise = t.request({ data: { method: 'restricted' } });
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);

    ws.simulateMessage({ id: sent.id, status: 'ERROR', error: 'Unauthorized', result: {} });

    const err = await promise.catch((e: TransportError) => e);
    expect(err.code).toBe('ERROR');
    expect(err.error).toBe('Unauthorized');

    t.destroy();
  });
});
