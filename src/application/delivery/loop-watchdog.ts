/**
 * Liveness of the background loops of a process (dispatcher publication and reconciliation,
 * worker jobs). A hung call (e.g. a database query that never returns) freezes a loop without
 * any error: readiness must then report not ready, and past a hard limit the process exits so
 * that the restart policy recovers it.
 *
 * Two kinds of watched units:
 * - heartbeat loops (`beat`): stale when no progress was reported for `staleAfterMs`;
 * - in-flight work (`track`): stale when the oldest unit still running started more than
 *   `staleAfterMs` ago; idle (nothing running) is always healthy.
 */
export interface WatchLimits {
  /** Older than this: not ready. */
  staleAfterMs: number;
  /** Older than this: the process is considered stuck and must exit. */
  fatalAfterMs: number;
}

export type LoopHealth = 'ok' | 'stale' | 'stuck';

export interface WatchdogStatus {
  ready: boolean;
  /** At least one loop is beyond its hard limit. */
  stuck: boolean;
  loops: Record<string, { ageMs: number; health: LoopHealth }>;
}

interface WatchedUnit {
  limits: WatchLimits;
  kind: 'heartbeat' | 'in_flight';
  lastBeat: number;
  inFlight: Map<number, number>;
}

/** Default limits from a loop interval: stale after max(30 s, 5 x interval), stuck after 5 x stale. */
export function limitsForInterval(intervalMs: number, minStaleMs = 30_000): WatchLimits {
  const staleAfterMs = Math.max(minStaleMs, 5 * intervalMs);
  return { staleAfterMs, fatalAfterMs: Math.max(300_000, 5 * staleAfterMs) };
}

export class LoopWatchdog {
  private readonly units = new Map<string, WatchedUnit>();
  private nextId = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A loop that reports progress through `beat` (registration counts as a first beat). */
  registerLoop(name: string, limits: WatchLimits): void {
    this.units.set(name, { limits, kind: 'heartbeat', lastBeat: this.now(), inFlight: new Map() });
  }

  /** Work units run through `track` (e.g. worker jobs). */
  registerInFlight(name: string, limits: WatchLimits): void {
    this.units.set(name, { limits, kind: 'in_flight', lastBeat: this.now(), inFlight: new Map() });
  }

  beat(name: string): void {
    const unit = this.units.get(name);
    if (unit !== undefined) unit.lastBeat = this.now();
  }

  async track<T>(name: string, run: () => Promise<T>): Promise<T> {
    const unit = this.units.get(name);
    if (unit === undefined) return run();
    const id = this.nextId++;
    unit.inFlight.set(id, this.now());
    try {
      return await run();
    } finally {
      unit.inFlight.delete(id);
      unit.lastBeat = this.now();
    }
  }

  status(): WatchdogStatus {
    const now = this.now();
    const loops: WatchdogStatus['loops'] = {};
    let ready = true;
    let stuck = false;
    for (const [name, unit] of this.units) {
      let since = now;
      if (unit.kind === 'heartbeat') {
        since = unit.lastBeat;
      } else {
        for (const startedAt of unit.inFlight.values()) since = Math.min(since, startedAt);
      }
      const ageMs = Math.max(0, now - since);
      const health: LoopHealth =
        ageMs > unit.limits.fatalAfterMs
          ? 'stuck'
          : ageMs > unit.limits.staleAfterMs
            ? 'stale'
            : 'ok';
      if (health !== 'ok') ready = false;
      if (health === 'stuck') stuck = true;
      loops[name] = { ageMs: Math.round(ageMs), health };
    }
    return { ready, stuck, loops };
  }

  /**
   * Checks the loops every `intervalMs`; `onStuck` is called once a loop exceeds its hard limit.
   * Returns a function stopping the monitor (call it when shutdown starts).
   */
  monitor(intervalMs: number, onStuck: (status: WatchdogStatus) => void): () => void {
    let fired = false;
    const timer = setInterval(() => {
      const status = this.status();
      if (status.stuck && !fired) {
        fired = true;
        onStuck(status);
      }
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }
}
