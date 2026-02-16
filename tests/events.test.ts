// =============================================================================
// Tests: events.ts
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { createEmitter } from '../src/events.js';

interface TestEvents {
  foo: string;
  bar: number;
  baz: undefined;
}

describe('createEmitter', () => {
  it('emits events to listeners', () => {
    const ee = createEmitter<TestEvents>();
    const fn = vi.fn();
    ee.on('foo', fn);
    ee.emit('foo', 'hello');
    expect(fn).toHaveBeenCalledWith('hello');
  });

  it('supports multiple listeners on same event', () => {
    const ee = createEmitter<TestEvents>();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    ee.on('bar', fn1);
    ee.on('bar', fn2);
    ee.emit('bar', 42);
    expect(fn1).toHaveBeenCalledWith(42);
    expect(fn2).toHaveBeenCalledWith(42);
  });

  it('returns unsubscribe function from on()', () => {
    const ee = createEmitter<TestEvents>();
    const fn = vi.fn();
    const unsub = ee.on('foo', fn);
    unsub();
    ee.emit('foo', 'ignored');
    expect(fn).not.toHaveBeenCalled();
  });

  it('off() removes a specific listener', () => {
    const ee = createEmitter<TestEvents>();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    ee.on('foo', fn1);
    ee.on('foo', fn2);
    ee.off('foo', fn1);
    ee.emit('foo', 'x');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledWith('x');
  });

  it('once() fires only once', () => {
    const ee = createEmitter<TestEvents>();
    const fn = vi.fn();
    ee.once('bar', fn);
    ee.emit('bar', 1);
    ee.emit('bar', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('once() returns unsubscribe that works before emit', () => {
    const ee = createEmitter<TestEvents>();
    const fn = vi.fn();
    const unsub = ee.once('bar', fn);
    unsub();
    ee.emit('bar', 99);
    expect(fn).not.toHaveBeenCalled();
  });

  it('removeAll() for specific event', () => {
    const ee = createEmitter<TestEvents>();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    ee.on('foo', fn1);
    ee.on('bar', fn2);
    ee.removeAll('foo');
    ee.emit('foo', 'x');
    ee.emit('bar', 1);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledWith(1);
  });

  it('removeAll() without args clears everything', () => {
    const ee = createEmitter<TestEvents>();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    ee.on('foo', fn1);
    ee.on('bar', fn2);
    ee.removeAll();
    ee.emit('foo', 'x');
    ee.emit('bar', 1);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('emit with no listeners is a no-op', () => {
    const ee = createEmitter<TestEvents>();
    expect(() => ee.emit('baz', undefined)).not.toThrow();
  });

  it('listener removing itself during emit does not break iteration', () => {
    const ee = createEmitter<TestEvents>();
    const fn2 = vi.fn();
    let unsub1: (() => void) | null = null;
    const fn1 = vi.fn(() => { unsub1!(); });
    unsub1 = ee.on('foo', fn1);
    ee.on('foo', fn2);
    ee.emit('foo', 'test');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});
