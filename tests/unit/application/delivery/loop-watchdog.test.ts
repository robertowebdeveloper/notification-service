import { describe, expect, it } from 'vitest';
import {
  limitsForInterval,
  LoopWatchdog,
} from '../../../../src/application/delivery/loop-watchdog.js';

describe('LoopWatchdog', () => {
  it('derives limits from the loop interval', () => {
    expect(limitsForInterval(1_000)).toEqual({ staleAfterMs: 30_000, fatalAfterMs: 300_000 });
    expect(limitsForInterval(20_000)).toEqual({ staleAfterMs: 100_000, fatalAfterMs: 500_000 });
    expect(limitsForInterval(1_000, 60_000).staleAfterMs).toBe(60_000);
  });

  it('reports a heartbeat loop without progress as not ready, then stuck', () => {
    let now = 0;
    const watchdog = new LoopWatchdog(() => now);
    watchdog.registerLoop('publish', { staleAfterMs: 30_000, fatalAfterMs: 120_000 });
    watchdog.registerLoop('reconcile', { staleAfterMs: 30_000, fatalAfterMs: 120_000 });

    now = 20_000;
    watchdog.beat('reconcile');
    expect(watchdog.status()).toMatchObject({ ready: true, stuck: false });

    now = 40_000;
    expect(watchdog.status()).toEqual({
      ready: false,
      stuck: false,
      loops: {
        publish: { ageMs: 40_000, health: 'stale' },
        reconcile: { ageMs: 20_000, health: 'ok' },
      },
    });

    now = 130_000;
    expect(watchdog.status()).toMatchObject({ ready: false, stuck: true });
    watchdog.beat('publish');
    watchdog.beat('reconcile');
    expect(watchdog.status()).toMatchObject({ ready: true, stuck: false });
  });

  it('in-flight work: idle is healthy, the oldest running unit decides', async () => {
    let now = 0;
    const watchdog = new LoopWatchdog(() => now);
    watchdog.registerInFlight('jobs', { staleAfterMs: 10_000, fatalAfterMs: 20_000 });

    now = 1_000_000;
    expect(watchdog.status().ready).toBe(true);

    let releaseHung: () => void = () => undefined;
    const hung = watchdog.track(
      'jobs',
      () =>
        new Promise<string>((resolve) => {
          releaseHung = () => {
            resolve('done');
          };
        }),
    );
    // Other jobs keep completing: they must not hide the hung one.
    now += 15_000;
    expect(await watchdog.track('jobs', () => Promise.resolve('quick'))).toBe('quick');
    expect(watchdog.status()).toMatchObject({
      ready: false,
      loops: { jobs: { ageMs: 15_000, health: 'stale' } },
    });
    now += 10_000;
    expect(watchdog.status().stuck).toBe(true);

    releaseHung();
    expect(await hung).toBe('done');
    expect(watchdog.status()).toMatchObject({ ready: true, stuck: false });
  });

  it('calls onStuck once from the monitor', async () => {
    let now = 0;
    const watchdog = new LoopWatchdog(() => now);
    watchdog.registerLoop('publish', { staleAfterMs: 10, fatalAfterMs: 20 });
    const calls: unknown[] = [];
    const stop = watchdog.monitor(5, (status) => calls.push(status.loops));
    now = 100;
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();
    expect(calls).toEqual([{ publish: { ageMs: 100, health: 'stuck' } }]);
  });
});
