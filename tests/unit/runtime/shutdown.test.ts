import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;
const EVENTS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
type Event = (typeof EVENTS)[number];

// process.listeners/removeListener are overloaded per event name; a string-keyed view is enough here.
const listenersOf = (event: Event) =>
  (process.listeners as unknown as (e: string) => Listener[]).call(process, event);
const removeListener = (event: Event, listener: Listener) => {
  (process.removeListener as unknown as (e: string, l: Listener) => void).call(
    process,
    event,
    listener,
  );
};

describe('installShutdown', () => {
  const before = new Map<Event, Listener[]>();
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    for (const event of EVENTS) before.set(event, listenersOf(event));
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const event of EVENTS) {
      for (const listener of listenersOf(event)) {
        if (!(before.get(event) ?? []).includes(listener)) removeListener(event, listener);
      }
    }
  });

  function added(event: Event): Listener {
    const existing = before.get(event) ?? [];
    const listener = listenersOf(event).find((l) => !existing.includes(l));
    if (!listener) throw new Error(`no ${event} listener installed`);
    return listener;
  }

  async function install(closers: (() => Promise<void>)[], graceMs = 1000) {
    const { installShutdown } = await import('../../../src/infrastructure/runtime/shutdown.js');
    const exit = vi.fn<(code: number) => void>();
    installShutdown(logger, graceMs, closers, exit);
    return exit;
  }

  it('runs closers in order on SIGTERM and exits 0, even if a closer fails', async () => {
    const order: string[] = [];
    const exit = await install([
      () => {
        order.push('queue');
        return Promise.resolve();
      },
      () => Promise.reject(new Error('boom')),
      () => {
        order.push('orm');
        return Promise.resolve();
      },
    ]);
    added('SIGTERM')('SIGTERM');
    await vi.runAllTimersAsync();
    expect(order).toEqual(['queue', 'orm']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('exits 1 when the closers exceed the grace period', async () => {
    const exit = await install([() => new Promise<void>(() => undefined)], 500);
    added('SIGINT')('SIGINT');
    await vi.advanceTimersByTimeAsync(499);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('logs and exits 1 on an unhandled rejection or an uncaught exception', async () => {
    const exit = await install([]);
    added('unhandledRejection')(new Error('rejected'), Promise.resolve());
    added('uncaughtException')(new Error('thrown'), 'uncaughtException');
    expect(exit.mock.calls).toEqual([[1], [1]]);
  });
});
