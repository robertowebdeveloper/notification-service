import { afterAll, afterEach, beforeAll } from 'vitest';
import { E2eSystem } from './system.js';

/**
 * Registers the per-file lifecycle: one isolated system (database + Valkey DB index = `slot`),
 * every service process SIGKILLed after each test, everything closed after the file.
 */
export function useE2eSystem(slot: number): () => E2eSystem {
  let system: E2eSystem | undefined;
  beforeAll(async () => {
    system = await E2eSystem.create({ slot });
  }, 120_000);
  afterEach(async () => {
    await system?.stopServices();
  }, 30_000);
  afterAll(async () => {
    await system?.dispose();
  }, 30_000);
  return () => {
    if (system === undefined) throw new Error('E2E system not initialised (see beforeAll error)');
    return system;
  };
}
