import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { E2E_ENV, PROJECT_ROOT, TIMING, freePort } from './env.js';
import { waitFor } from './wait-for.js';

/**
 * Real service processes started from the TypeScript entrypoints. They run as a single node
 * process (`node --import tsx <entry>`), never through the tsx CLI wrapper, so that SIGKILL,
 * SIGSTOP and SIGTERM reach the process that actually holds connections and timers.
 */
export const ENTRYPOINTS = {
  api: 'src/entrypoints/api.ts',
  dispatcher: 'src/entrypoints/dispatcher.ts',
  worker: 'src/entrypoints/worker.ts',
  migrate: 'src/entrypoints/migrate.ts',
  'config-apply': 'src/entrypoints/config-apply.ts',
} as const;
export type ServiceRole = keyof typeof ENTRYPOINTS;

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const MAX_LINES = 20_000;
const live = new Set<ServiceProcess>();

process.once('exit', () => {
  for (const service of live) service.child.kill('SIGKILL');
});

export class ServiceProcess {
  readonly lines: string[] = [];
  readonly exited: Promise<ExitInfo>;
  exitInfo: ExitInfo | undefined;
  private readonly listeners = new Set<(line: string) => void>();
  private readonly logFile: WriteStream | undefined;

  constructor(
    readonly name: string,
    readonly role: ServiceRole,
    readonly child: ChildProcess,
  ) {
    if (E2E_ENV.logDir !== undefined) {
      mkdirSync(E2E_ENV.logDir, { recursive: true });
      this.logFile = createWriteStream(
        path.join(E2E_ENV.logDir, `${name}-${String(child.pid)}.log`),
      );
    }
    const onLine = (line: string) => {
      this.lines.push(line);
      if (this.lines.length > MAX_LINES) this.lines.shift();
      this.logFile?.write(`${line}\n`);
      for (const listener of this.listeners) listener(line);
    };
    if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine);
    if (child.stderr) createInterface({ input: child.stderr }).on('line', onLine);
    this.exited = new Promise<ExitInfo>((resolve) => {
      child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        live.delete(this);
        this.logFile?.end();
        resolve(this.exitInfo);
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.exitInfo === undefined;
  }

  signal(signal: NodeJS.Signals): void {
    if (this.running) this.child.kill(signal);
  }

  /** Last lines of output, for failure diagnostics. */
  tail(count = 60): string {
    const exit =
      this.exitInfo === undefined
        ? 'running'
        : `exited code=${String(this.exitInfo.code)} signal=${String(this.exitInfo.signal)}`;
    return [
      `--- ${this.name} (pid ${String(this.pid)}, ${exit}) ---`,
      ...this.lines.slice(-count),
    ].join('\n');
  }

  /** Resolves with the first output line matching `pattern`; rejects if the process exits. */
  waitForLine(pattern: RegExp, timeoutMs = TIMING.startupMs): Promise<string> {
    const existing = this.lines.find((line) => pattern.test(line));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      const listener = (line: string) => {
        if (!pattern.test(line)) return;
        cleanup();
        resolve(line);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.name}: no output matching ${String(pattern)}\n${this.tail()}`));
      }, timeoutMs);
      this.listeners.add(listener);
      void this.exited.then(() => {
        if (!this.listeners.has(listener)) return;
        cleanup();
        reject(new Error(`${this.name} exited before ${String(pattern)}\n${this.tail()}`));
      });
    });
  }

  /** Sends `signal` (default SIGTERM) and waits for exit, escalating to SIGKILL on timeout. */
  async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = TIMING.shutdownGraceMs + 10_000) {
    if (!this.running) return this.exited;
    this.child.kill(signal);
    const timer = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Abrupt crash: SIGKILL (resuming first if the process was stopped). */
  async kill(): Promise<ExitInfo> {
    if (!this.running) return this.exited;
    this.child.kill('SIGKILL');
    return this.exited;
  }
}

export interface SpawnOptions {
  name?: string;
  env: Record<string, string>;
  args?: string[];
}

function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  // Never leak test-runner loader hooks or the developer's app configuration into the services.
  delete base.NODE_OPTIONS;
  const omitted = new Set([
    'DATABASE_URL',
    'VALKEY_URL',
    'HTTP_PORT',
    'HTTP_HOST',
    'APP_ENV',
    'SECRETS_DIR',
  ]);
  const filtered = Object.fromEntries(Object.entries(base).filter(([key]) => !omitted.has(key)));
  return { ...filtered, ...env };
}

/** Spawns a service; callers must pass a distinct OPS_PORT (see E2eSystem / runToCompletion). */
export function spawnService(role: ServiceRole, options: SpawnOptions): ServiceProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', ENTRYPOINTS[role], ...(options.args ?? [])],
    { cwd: PROJECT_ROOT, env: childEnv(options.env), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const service = new ServiceProcess(options.name ?? role, role, child);
  live.add(service);
  return service;
}

export interface CompletedRun {
  exit: ExitInfo;
  output: string;
  lines: string[];
}

/** Runs a one-shot entrypoint (migrate, config-apply) to completion. */
export async function runToCompletion(
  role: ServiceRole,
  options: SpawnOptions & { timeoutMs?: number },
): Promise<CompletedRun> {
  // Every process gets its own ops port: several services share one host during the suite.
  const env =
    options.env.OPS_PORT === undefined
      ? { ...options.env, OPS_PORT: String(await freePort()) }
      : options.env;
  const service = spawnService(role, { ...options, env });
  const timer = setTimeout(() => service.child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
  try {
    const exit = await service.exited;
    return { exit, output: service.lines.join('\n'), lines: [...service.lines] };
  } finally {
    clearTimeout(timer);
  }
}

/** SIGKILLs every process still alive (resuming stopped ones first). Use in afterEach/afterAll. */
export async function killAllServices(): Promise<void> {
  const services = [...live];
  for (const service of services) {
    service.signal('SIGCONT');
    service.child.kill('SIGKILL');
  }
  await Promise.all(services.map((service) => service.exited));
}

export function liveServices(): ServiceProcess[] {
  return [...live];
}

/** Polls an HTTP readiness endpoint until it answers 200. */
export async function waitForHttpReady(
  service: ServiceProcess,
  url: string,
  timeoutMs = TIMING.startupMs,
): Promise<void> {
  await waitFor(
    async () => {
      if (!service.running) throw new Error(`${service.name} exited`);
      const response = await fetch(url);
      return response.status === 200;
    },
    {
      timeoutMs,
      description: `${service.name} ready at ${url}`,
      diagnostics: () => service.tail(),
    },
  );
}
