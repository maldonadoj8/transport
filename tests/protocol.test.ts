// =============================================================================
// Tests: protocol.ts
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  normalizeIncoming,
  buildOutgoing,
} from '../src/protocol.js';
import type { ProtocolSchema } from '../src/types.js';

// ======================== TEST PROTOCOL ======================================

/** A complete protocol schema used across all tests. */
function testProtocol(overrides?: Partial<ProtocolSchema>): ProtocolSchema {
  return {
    fields: {
      channel:     'action',
      messageId:   'reqId',
      type:        'type',
      code:        'status',
      description: 'desc',
      data:        'payload',
    },
    codes: {
      success: 'OK',
      interim: 'PENDING',
    },
    responseTypes: {
      NONE:       0,
      SILENT:     1,
      MESSAGE:    2,
      PROCESSING: 4,
      ALERT:      8,
      ALL:        15,
    },
    generateId(): number {
      return Math.floor(Math.random() * 1_000_000_000) + 1;
    },
    encode(message: Record<string, unknown>): string {
      return JSON.stringify(message);
    },
    decode(raw: string): Record<string, unknown> | null {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    flattenOutgoing: true,
    ...overrides,
  };
}

// ======================== normalizeIncoming ===================================

describe('normalizeIncoming', () => {
  it('maps wire fields to canonical shape', () => {
    const schema = testProtocol();
    const raw = {
      action: 'usuario',
      reqId: 42,
      type: 6,
      status: 'OK',
      desc: 'Success',
      payload: { usuario: [{ id: 1 }] },
    };
    const msg = normalizeIncoming(raw, schema);
    expect(msg.channel).toBe('usuario');
    expect(msg.messageId).toBe(42);
    expect(msg.type).toBe(6);
    expect(msg.code).toBe('OK');
    expect(msg.description).toBe('Success');
    expect(msg.data).toEqual({ usuario: [{ id: 1 }] });
    expect(msg.raw).toBe(raw);
  });

  it('uses custom field names', () => {
    const schema = testProtocol({
      fields: {
        channel: 'op',
        messageId: 'id',
        type: 'kind',
        code: 'result',
        description: 'text',
        data: 'body',
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
    expect(msg.channel).toBe('');
    expect(msg.messageId).toBe(0);
    expect(msg.type).toBe(0);
    expect(msg.code).toBe('');
    expect(msg.description).toBe('');
    expect(msg.data).toEqual({});
  });
});

// ======================== buildOutgoing ======================================

describe('buildOutgoing', () => {
  it('builds flat wire message when flattenOutgoing=true', () => {
    const schema = testProtocol();
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
      reqId: 42,
      payload: { id: 5 },
    });
  });

  it('handles no data', () => {
    const schema = testProtocol();
    const wire = buildOutgoing({ channel: 'ping' }, 1, schema);
    expect(wire).toEqual({ action: 'ping', reqId: 1 });
  });

  it('uses custom field names', () => {
    const schema = testProtocol({
      fields: {
        channel: 'cmd',
        messageId: 'mid',
        type: 'type',
        code: 'code',
        description: 'desc',
        data: 'data',
      },
    });
    const wire = buildOutgoing({ channel: 'test' }, 7, schema);
    expect(wire).toEqual({ cmd: 'test', mid: 7 });
  });
});
