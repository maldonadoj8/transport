// =============================================================================
// @silas/transport — Protocol
//
// Protocol schema helpers for normalizing incoming and building outgoing
// wire-format messages. Includes `resolveSchema()` which applies sensible
// defaults so consumers can provide a minimal (or empty) schema.
// =============================================================================

import type {
  ProtocolSchema,
  ResolvedProtocolSchema,
  IncomingMessage,
  OutgoingMessage,
} from './types.js';

// ======================== DEFAULTS ===========================================

/** Cryptographically random 32-bit unsigned integer. */
function defaultGenerateId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function defaultEncode(message: Record<string, unknown>): string {
  return JSON.stringify(message);
}

function defaultDecode(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ======================== RESOLVE ============================================

/**
 * Apply defaults to a partial `ProtocolSchema`, producing a fully
 * resolved schema ready for internal use.
 */
export function resolveSchema(input?: ProtocolSchema): ResolvedProtocolSchema {
  return {
    fields:             input?.fields             ?? {},
    codes:              input?.codes,
    generateId:         input?.generateId         ?? defaultGenerateId,
    encode:             input?.encode             ?? defaultEncode,
    decode:             input?.decode             ?? defaultDecode,
    flattenOutgoing:    input?.flattenOutgoing    ?? false,
    includeIdInRequest: input?.includeIdInRequest ?? false,
  };
}

// ======================== NORMALIZE / BUILD ==================================

/**
 * Transform a raw wire message into the canonical IncomingMessage shape.
 * Reads field names from the protocol schema so the rest of the library
 * can work with a stable, protocol-agnostic structure.
 */
export function normalizeIncoming(
  raw: Record<string, unknown>,
  schema: ResolvedProtocolSchema,
): IncomingMessage {
  const f = schema.fields;

  // Channel resolution: responseChannel → subscriptionChannel → '*'
  let channel = '';
  if (f.responseChannel) {
    channel = String(raw[f.responseChannel] ?? '');
  }
  if (!channel && f.subscriptionChannel) {
    channel = String(raw[f.subscriptionChannel] ?? '');
  }
  if (!channel) {
    channel = '*';
  }

  const rawId = f.messageId ? Number(raw[f.messageId] ?? 0) : 0;
  const messageId = Number.isNaN(rawId) ? 0 : rawId;

  // Event detection: has a resolved channel but no messageId.
  // For events, prefer eventBody over body.
  const isEvent = !messageId && channel !== '*';
  const bodyField = isEvent && f.eventBody ? f.eventBody : f.body;

  return {
    channel,
    messageId,
    code:        f.code        ? String(raw[f.code] ?? '')            : '',
    description: f.description ? String(raw[f.description] ?? '')    : '',
    error:       f.error       ? raw[f.error]                        : undefined,
    data:        bodyField     ? (raw[bodyField] as Record<string, unknown>) ?? {} : {},
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
 *
 * The optional `flattenOutgoing` parameter overrides the schema-level default
 * for a single call. When omitted, `schema.flattenOutgoing` is used.
 */
export function buildOutgoing<PData = Record<string, unknown>>(
  msg: OutgoingMessage<PData>,
  messageId: number,
  schema: ResolvedProtocolSchema,
  flattenOutgoing?: boolean,
): Record<string, unknown> {
  const f = schema.fields;
  const wire: Record<string, unknown> = {};

  // Only include the channel field when the schema defines a requestChannel.
  if (f.requestChannel) {
    wire[f.requestChannel] = msg.channel ?? '*';
  }

  // Only include the messageId on the wire when the schema opts in or use a default "id" falback field.
  if (schema.includeIdInRequest) {
    wire[f.messageId ?? 'id'] = messageId;
  }

  if (msg.data) {
    const data = msg.data as Record<string, unknown>;
    const shouldFlatten = flattenOutgoing ?? schema.flattenOutgoing;
    if (shouldFlatten) {
      // Flatten: spread data keys onto the root object.
      for (const key of Object.keys(data)) {
        wire[key] = data[key];
      }
    } else if (f.payload) {
      // Nested: data goes under its own field.
      wire[f.payload] = data;
    }
  }

  return wire;
}
