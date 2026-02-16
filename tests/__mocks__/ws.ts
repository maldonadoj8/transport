// =============================================================================
// Mock WebSocket for tests
//
// A controllable WebSocket mock that lets tests simulate:
//   - Connection open/close events
//   - Incoming messages
//   - Send interception
//   - Error events
//   - ReadyState transitions
// =============================================================================

export const WS_CONNECTING = 0;
export const WS_OPEN       = 1;
export const WS_CLOSING    = 2;
export const WS_CLOSED     = 3;

// CloseEvent polyfill for Node.js (not available in Node < 22).
class MockCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  constructor(type: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
    super(type);
    this.code     = init?.code     ?? 1000;
    this.reason   = init?.reason   ?? '';
    this.wasClean = init?.wasClean ?? true;
  }
}

// MessageEvent polyfill for Node.js.
class MockMessageEvent extends Event {
  readonly data: unknown;
  constructor(type: string, init?: { data?: unknown }) {
    super(type);
    this.data = init?.data ?? null;
  }
}

/** Tracks all MockWebSocket instances created (for assertions). */
export const instances: MockWebSocket[] = [];

/** Clear the instance tracker. */
export function resetInstances(): void {
  instances.length = 0;
}

/** Get the most recent MockWebSocket instance. */
export function lastInstance(): MockWebSocket | undefined {
  return instances[instances.length - 1];
}

export class MockWebSocket {
  // Spec properties
  url: string;
  readyState: number = WS_CONNECTING;
  onopen:    ((evt: Event) => void) | null = null;
  onclose:   ((evt: CloseEvent) => void) | null = null;
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror:   ((evt: Event) => void) | null = null;

  /** All messages sent via send(). */
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  // ---- methods ----

  send(data: string): void {
    if (this.readyState !== WS_OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WS_CLOSED || this.readyState === WS_CLOSING) return;
    this.readyState = WS_CLOSING;
    // Simulate async close.
    queueMicrotask(() => {
      this.readyState = WS_CLOSED;
      if (this.onclose) {
        this.onclose(new MockCloseEvent('close', {
          code: code ?? 1000,
          reason: reason ?? '',
          wasClean: true,
        }) as CloseEvent);
      }
    });
  }

  // ---- test helpers: simulate server-side events ----

  /** Simulate the connection being established. */
  simulateOpen(): void {
    this.readyState = WS_OPEN;
    if (this.onopen) {
      this.onopen(new Event('open'));
    }
  }

  /** Simulate the server closing the connection. */
  simulateClose(code = 1000, reason = ''): void {
    this.readyState = WS_CLOSED;
    if (this.onclose) {
      this.onclose(new MockCloseEvent('close', { code, reason, wasClean: code === 1000 }) as CloseEvent);
    }
  }

  /** Simulate receiving a message from the server. */
  simulateMessage(data: string | Record<string, unknown>): void {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    if (this.onmessage) {
      this.onmessage(new MockMessageEvent('message', { data: raw }) as MessageEvent);
    }
  }

  /** Simulate a WebSocket error. */
  simulateError(): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }

  // ---- static properties to match the WebSocket spec ----
  static readonly CONNECTING = WS_CONNECTING;
  static readonly OPEN       = WS_OPEN;
  static readonly CLOSING    = WS_CLOSING;
  static readonly CLOSED     = WS_CLOSED;
}

/**
 * Install the mock: replace globalThis.WebSocket with MockWebSocket.
 * Returns a restore function.
 */
export function installMock(): () => void {
  const original = globalThis.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = MockWebSocket as any;
  resetInstances();
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = original;
    resetInstances();
  };
}
