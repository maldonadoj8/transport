// =============================================================================
// @silas/transport — Protocol
//
// Protocol schema helpers for normalizing incoming and building outgoing
// wire-format messages. Consumers must provide a complete ProtocolSchema
// when creating a transport — there are no built-in defaults.
// =============================================================================

import type {
  ProtocolSchema,
  IncomingMessage,
  OutgoingMessage,
} from './types.js';

// ======================== NORMALIZE / BUILD ==================================

/**
 * Transform a raw wire message into the canonical IncomingMessage shape.
 * Reads field names from the protocol schema so the rest of the library
 * can work with a stable, protocol-agnostic structure.
 */
export function normalizeIncoming(
  raw: Record<string, unknown>,
  schema: ProtocolSchema,
): IncomingMessage {
  const f = schema.fields;
  return {
    channel:     String(raw[f.responseChannel] ?? ''),
    messageId:   Number(raw[f.messageId]       ?? 0),
    type:        Number(raw[f.type]            ?? 0),
    code:        String(raw[f.code]            ?? ''),
    description: String(raw[f.description]     ?? ''),
    data:        (raw[f.body] as Record<string, unknown>) ?? {},
    raw,
  };
}

/**
 * Build a wire-format message object from an OutgoingMessage.
 *
 * If `flattenOutgoing` is true, data keys are spread onto the root
 * alongside the channel and message ID fields.
 *
 * If false, data is nested under the data field name.
 */
export function buildOutgoing(
  msg: OutgoingMessage,
  messageId: number,
  schema: ProtocolSchema,
): Record<string, unknown> {
  const f = schema.fields;
  const wire: Record<string, unknown> = {
    [f.requestChannel]: msg.channel,
    [f.messageId]: messageId,
  };

  if (msg.data) {
    if (schema.flattenOutgoing) {
      // Flatten: spread data keys onto the root object.
      for (const key of Object.keys(msg.data)) {
        wire[key] = msg.data[key];
      }
    } else {
      // Nested: data goes under its own field.
      wire[f.payload] = msg.data;
    }
  }

  return wire;
}
