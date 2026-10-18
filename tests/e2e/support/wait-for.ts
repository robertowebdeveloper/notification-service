import { setTimeout as delay } from 'node:timers/promises';

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** What is being waited for; included in the timeout error. */
  description: string;
  /** Extra diagnostics appended to the timeout error (e.g. process log tails). */
  diagnostics?: () => string | Promise<string>;
}

export class WaitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaitTimeoutError';
  }
}

function describe(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
  } catch {
    return String(value);
  }
}

/**
 * Polls `probe` until it returns something other than `undefined`/`false`, or the timeout
 * expires. Probe errors are retried (the system may still be starting) and reported on timeout.
 */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  options: WaitOptions,
): Promise<T> {
  const interval = options.intervalMs ?? 250;
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  let lastValue: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
      lastValue = value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
  const parts = [`Timed out after ${options.timeoutMs} ms waiting for ${options.description}.`];
  if (lastError !== undefined) {
    parts.push(
      `Last error: ${lastError instanceof Error ? lastError.message : describe(lastError)}`,
    );
  } else {
    parts.push(`Last value: ${describe(lastValue)}`);
  }
  if (options.diagnostics) parts.push(await options.diagnostics());
  throw new WaitTimeoutError(parts.join('\n'));
}

/**
 * Asserts that `probe` keeps returning true for the whole window (negative assertions such as
 * "no further send happens"). Fails fast on the first violation.
 */
export async function holdsFor(
  probe: () => Promise<boolean> | boolean,
  options: {
    durationMs: number;
    intervalMs?: number;
    description: string;
    diagnostics?: () => string | Promise<string>;
  },
): Promise<void> {
  const deadline = Date.now() + options.durationMs;
  for (;;) {
    if (!(await probe())) {
      const extra = options.diagnostics ? `\n${await options.diagnostics()}` : '';
      throw new Error(`Invariant violated: ${options.description}${extra}`);
    }
    if (Date.now() >= deadline) return;
    await delay(options.intervalMs ?? 250);
  }
}

export { delay };
