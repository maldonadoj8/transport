// =============================================================================
// Tests: protocol.ts
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  normalizeIncoming,
  buildOutgoing,
  resolveSchema,
} from '../src/protocol.js';
import type { ProtocolSchema, ResolvedProtocolSchema } from '../src/types.js';

// ======================== TEST PROTOCOL ======================================

/** A complete protocol schema used across all tests. */
function testProtocol(overrides?: Partial<ProtocolSchema>): ResolvedProtocolSchema {
  return resolveSchema({
    fields: {
      requestChannel:  'action',
      responseChannel: 'action',
      messageId:       'reqId',
      code:            'status',
      description:     'desc',
      payload:         'payload',
      body:            'payload',
    },
    codes: {
      success:         'OK',
      interim:         'PENDING',
      error:           ['ERROR'],
    },
    flattenOutgoing: true,
    ...overrides,
  });
}

// ======================== normalizeIncoming ===================================

describe('normalizeIncoming', () => {
  it('maps wire fields to canonical shape', () => {
    const schema = testProtocol();
    const raw = {
      action: 'usuario',
      reqId: 42,
      status: 'OK',
      desc: 'Success',
      payload: { usuario: [{ id: 1 }] },
    };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('usuario');
    expect(msg.messageId).toBe(42);
    expect(msg.code).toBe('OK');
    expect(msg.description).toBe('Success');
    expect(msg.error).toBeUndefined();
    expect(msg.data).toEqual({ usuario: [{ id: 1 }] });
    expect(msg.raw).toBe(raw);
  });

  it('uses custom field names', () => {
    const schema = testProtocol({
      fields: {
        requestChannel:  'cmd',
        responseChannel: 'op',
        messageId: 'id',
        code: 'result',
        description: 'text',
        payload: 'input',
        body: 'body',
      },
    });
    const raw = { op: 'test', id: 99, result: 'OK' };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('test');
    expect(msg.messageId).toBe(99);
    expect(msg.code).toBe('OK');
  });

  it('handles missing fields gracefully', () => {
    const schema = testProtocol();
    const msg = normalizeIncoming({}, schema);
    expect(msg.channel).toBe('*');
    expect(msg.messageId).toBe(0);
    expect(msg.code).toBe('');
    expect(msg.description).toBe('');
    expect(msg.error).toBeUndefined();
    expect(msg.data).toEqual({});
  });

  it('falls back to subscriptionChannel when responseChannel is empty', () => {
    const schema = testProtocol({
      fields: {
        requestChannel:       'method',
        responseChannel:      'method',
        subscriptionChannel:  'e',
        messageId:            'id',
        code:                 'status',
        description:          'desc',
        payload:              'params',
        body:                 'data',
      },
    });
    // Message has no 'method' (responseChannel) but has 'e' (subscriptionChannel).
    const raw = { e: 'aggTrade', id: 0, data: { price: '0.001' } };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('aggTrade');
  });

  it('prefers responseChannel over subscriptionChannel when both present', () => {
    const schema = testProtocol({
      fields: {
        requestChannel:       'method',
        responseChannel:      'method',
        subscriptionChannel:  'e',
        messageId:            'id',
        code:                 'status',
        description:          'desc',
        payload:              'params',
        body:                 'data',
      },
    });
    const raw = { method: 'market_update', e: 'aggTrade', id: 0 };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('market_update');
  });

  it('works without subscriptionChannel defined', () => {
    // Default testProtocol has no subscriptionChannel — should still work.
    const schema = testProtocol();
    const raw = { action: 'test', reqId: 1 };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('test');
  });

  it('maps error wire field to IncomingMessage.error', () => {
    const schema = testProtocol({
      fields: {
        requestChannel:  'action',
        responseChannel: 'action',
        messageId:       'reqId',
        code:            'status',
        description:     'desc',
        error:           'err',
        payload:         'payload',
        body:            'payload',
      },
    });
    const raw = { action: 'test', reqId: 1, status: 'ERROR', desc: 'Something failed', err: { message: 'detailed error', code: 42 } };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.description).toBe('Something failed');
    expect(msg.error).toEqual({ message: 'detailed error', code: 42 });
  });

  it('maps string error wire field', () => {
    const schema = testProtocol({
      fields: {
        messageId: 'id',
        code:      'status',
        error:     'error',
        body:      'result',
      },
    });
    const raw = { id: 1, status: 'ERROR', error: 'Not found', result: {} };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.error).toBe('Not found');
    expect(msg.description).toBe('');
  });

  it('defaults all optional fields when none are provided', () => {
    const schema = testProtocol({
      fields: {},
    });
    const raw = { action: 'test', id: 1, code: 'OK', desc: 'hi' };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('*');
    expect(msg.messageId).toBe(0);
    expect(msg.code).toBe('');
    expect(msg.description).toBe('');
    expect(msg.error).toBeUndefined();
    expect(msg.data).toEqual({});
  });

  it('uses eventBody for event messages (no messageId, has channel)', () => {
    const schema = testProtocol({
      fields: {
        responseChannel:     'method',
        subscriptionChannel: 'method',
        messageId:           'id',
        code:                'status',
        body:                'result',
        eventBody:           'params',
      },
    });
    // Event: has channel via subscriptionChannel, messageId = 0.
    const raw = { method: 'trades_update', id: 0, params: ['ETH_BTC', { price: '0.05' }] };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('trades_update');
    expect(msg.messageId).toBe(0);
    expect(msg.data).toEqual(['ETH_BTC', { price: '0.05' }]);
  });

  it('uses body (not eventBody) for response messages with messageId', () => {
    const schema = testProtocol({
      fields: {
        responseChannel:     'method',
        subscriptionChannel: 'method',
        messageId:           'id',
        code:                'status',
        body:                'result',
        eventBody:           'params',
      },
    });
    // Response: has messageId > 0.
    const raw = { id: 42, status: 'OK', result: { status: 'success' }, params: ['stale'] };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.messageId).toBe(42);
    expect(msg.data).toEqual({ status: 'success' });
  });

  it('falls back to body when eventBody is omitted for events', () => {
    const schema = testProtocol({
      fields: {
        subscriptionChannel: 'method',
        messageId:           'id',
        body:                'result',
      },
    });
    // Event without eventBody defined — should use body.
    const raw = { method: 'update', id: 0, result: { foo: 'bar' } };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.data).toEqual({ foo: 'bar' });
  });
});

// ======================== buildOutgoing ======================================

describe('buildOutgoing', () => {
  it('builds flat wire message when flattenOutgoing=true (no id by default)', () => {
    const schema = testProtocol();
    const wire = buildOutgoing(
      { channel: 'usuario', data: { id: 5, nombre: 'Ana' } },
      42,
      schema,
    );
    expect(wire).toEqual({
      action: 'usuario',
      id: 5,
      nombre: 'Ana',
    });
    // messageId should NOT be on the wire when includeIdInRequest is false/undefined.
    expect(wire).not.toHaveProperty('reqId');
  });

  it('includes messageId on wire when includeIdInRequest=true', () => {
    const schema = testProtocol({ includeIdInRequest: true });
    const wire = buildOutgoing(
      { channel: 'usuario', data: { id: 5, nombre: 'Ana' } },
      42,
      schema,
    );
    expect(wire).toEqual({
      action: 'usuario',
      reqId: 42,
      id: 5,
      nombre: 'Ana',
    });
  });

  it('builds nested wire message when flattenOutgoing=false', () => {
    const schema = testProtocol({ flattenOutgoing: false });
    const wire = buildOutgoing(
      { channel: 'usuario', data: { id: 5 } },
      42,
      schema,
    );
    expect(wire).toEqual({
      action: 'usuario',
      payload: { id: 5 },
    });
    expect(wire).not.toHaveProperty('reqId');
  });

  it('includes messageId in nested mode when includeIdInRequest=true', () => {
    const schema = testProtocol({ flattenOutgoing: false, includeIdInRequest: true });
    const wire = buildOutgoing(
      { channel: 'usuario', data: { id: 5 } },
      42,
      schema,
    );
    expect(wire).toEqual({
      action: 'usuario',
      reqId: 42,
      payload: { id: 5 },
    });
  });

  it('handles no data', () => {
    const schema = testProtocol();
    const wire = buildOutgoing({ channel: 'ping' }, 1, schema);
    expect(wire).toEqual({ action: 'ping' });
  });

  it('handles no data with includeIdInRequest=true', () => {
    const schema = testProtocol({ includeIdInRequest: true });
    const wire = buildOutgoing({ channel: 'ping' }, 1, schema);
    expect(wire).toEqual({ action: 'ping', reqId: 1 });
  });

  it('uses custom field names', () => {
    const schema = testProtocol({
      fields: {
        requestChannel:  'cmd',
        responseChannel: 'op',
        messageId: 'mid',
        code: 'code',
        description: 'desc',
        payload: 'data',
        body: 'data',
      },
      includeIdInRequest: true,
    });
    const wire = buildOutgoing({ channel: 'test' }, 7, schema);
    expect(wire).toEqual({ cmd: 'test', mid: 7 });
  });

  it('omits channel key when requestChannel is undefined', () => {
    const schema = testProtocol({
      fields: {
        responseChannel: 'op',
        messageId: 'id',
        code: 'code',
        description: 'desc',
        payload: 'params',
        body: 'result',
      },
      includeIdInRequest: true,
    });
    const wire = buildOutgoing({ data: { method: 'ping' } }, 5, schema);
    expect(wire).toEqual({ id: 5, method: 'ping' });
    // No channel key at all on the wire.
    expect(Object.keys(wire)).not.toContain('action');
  });

  it('builds correctly with no requestChannel and no data', () => {
    const schema = testProtocol({
      fields: {
        messageId: 'id',
        code: 'code',
        description: 'desc',
        payload: 'params',
        body: 'result',
      },
      includeIdInRequest: true,
    });
    const wire = buildOutgoing({}, 3, schema);
    expect(wire).toEqual({ id: 3 });
  });
});

// ======================== channel-less protocol ==============================

describe('channel-less protocol', () => {
  it('normalizeIncoming falls back to * when no responseChannel defined', () => {
    const schema = testProtocol({
      fields: {
        messageId: 'id',
        code: 'code',
        description: 'desc',
        payload: 'params',
        body: 'result',
      },
    });
    const raw = { id: 1, code: 'OK', result: { foo: 'bar' } };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('*');
    expect(msg.messageId).toBe(1);
    expect(msg.data).toEqual({ foo: 'bar' });
  });

  it('normalizeIncoming still uses subscriptionChannel even without responseChannel', () => {
    const schema = testProtocol({
      fields: {
        subscriptionChannel: 'e',
        messageId: 'id',
        code: 'code',
        description: 'desc',
        payload: 'params',
        body: 'result',
      },
    });
    const raw = { e: 'trade', id: 0, result: {} };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('trade');
  });
});

// ======================== resolveSchema ======================================

describe('resolveSchema', () => {
  it('returns full defaults when called with no arguments', () => {
    const schema = resolveSchema();
    expect(schema.fields).toEqual({});
    expect(schema.codes).toBeUndefined();
    expect(schema.flattenOutgoing).toBe(false);
    expect(schema.includeIdInRequest).toBe(false);
    expect(typeof schema.generateId).toBe('function');
    expect(typeof schema.encode).toBe('function');
    expect(typeof schema.decode).toBe('function');
  });

  it('returns full defaults when called with empty object', () => {
    const schema = resolveSchema({});
    expect(schema.fields).toEqual({});
    expect(schema.flattenOutgoing).toBe(false);
    expect(schema.includeIdInRequest).toBe(false);
  });

  it('default generateId returns a number', () => {
    const schema = resolveSchema();
    const id = schema.generateId();
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThanOrEqual(0);
  });

  it('default encode produces JSON string', () => {
    const schema = resolveSchema();
    expect(schema.encode({ a: 1 })).toBe('{"a":1}');
  });

  it('default decode parses JSON', () => {
    const schema = resolveSchema();
    expect(schema.decode('{"a":1}')).toEqual({ a: 1 });
  });

  it('default decode returns null on invalid JSON', () => {
    const schema = resolveSchema();
    expect(schema.decode('not json')).toBeNull();
  });

  it('preserves custom overrides', () => {
    const customGen = () => 42;
    const customEncode = (msg: Record<string, unknown>) => `custom:${JSON.stringify(msg)}`;
    const schema = resolveSchema({
      fields: { messageId: 'id', body: 'result' },
      flattenOutgoing: true,
      includeIdInRequest: true,
      generateId: customGen,
      encode: customEncode,
    });
    expect(schema.fields).toEqual({ messageId: 'id', body: 'result' });
    expect(schema.flattenOutgoing).toBe(true);
    expect(schema.includeIdInRequest).toBe(true);
    expect(schema.generateId).toBe(customGen);
    expect(schema.encode).toBe(customEncode);
  });
});

// ======================== normalizeIncoming edge cases =======================

describe('normalizeIncoming — edge cases', () => {
  it('coerces non-numeric messageId to 0', () => {
    const schema = testProtocol();
    const raw = { action: 'test', reqId: 'not-a-number', status: 'OK' };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.messageId).toBe(0);
  });

  it('coerces NaN messageId to 0', () => {
    const schema = testProtocol();
    const raw = { action: 'test', reqId: NaN, status: 'OK' };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.messageId).toBe(0);
  });

  it('treats empty string channel as wildcard *', () => {
    const schema = testProtocol();
    // Action field present but empty string value.
    const raw = { action: '', reqId: 1, status: 'OK' };
    const msg = normalizeIncoming(raw, schema);
    // Empty responseChannel falls back to subscriptionChannel (none defined)
    // then to '*'.
    expect(msg.channel).toBe('*');
  });

  it('eventBody takes precedence over body for event messages (messageId=0)', () => {
    const schema = testProtocol({
      fields: {
        responseChannel:     'method',
        subscriptionChannel: 'event',
        messageId:           'reqId',
        code:                'status',
        body:                'result',
        eventBody:           'params',
      },
    });
    // Event: messageId=0, channel via subscriptionChannel.
    const raw = { event: 'trade_update', reqId: 0, params: [1, 2, 3], result: { stale: true } };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('trade_update');
    expect(msg.messageId).toBe(0);
    // Should use params (eventBody), not result (body).
    expect(msg.data).toEqual([1, 2, 3]);
  });

  it('body is used for response messages (messageId>0) even when eventBody defined', () => {
    const schema = testProtocol({
      fields: {
        responseChannel: 'method',
        messageId:       'reqId',
        code:            'status',
        body:            'result',
        eventBody:       'params',
      },
    });
    // Response: messageId > 0.
    const raw = { method: 'order_create', reqId: 55, status: 'OK', result: { id: 100 }, params: ['stale'] };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.messageId).toBe(55);
    // Should use result (body), not params (eventBody).
    expect(msg.data).toEqual({ id: 100 });
  });
});
