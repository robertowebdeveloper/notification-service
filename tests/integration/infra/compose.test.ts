import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');

interface PortConfig {
  host_ip?: string;
  target: number;
  published?: string;
}
interface ServiceConfig {
  ports?: PortConfig[];
  profiles?: string[];
  healthcheck?: { test?: string[]; disable?: boolean };
  depends_on?: Record<string, { condition: string }>;
  environment?: Record<string, string>;
  restart?: string;
  stop_grace_period?: string;
  secrets?: { source: string; target: string }[];
}
interface ComposeConfig {
  services: Record<string, ServiceConfig>;
}

const APP_SERVICES = ['api', 'dispatcher', 'migrate', 'worker-email'];

function dockerComposeAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgres://u:p@db.invalid:5432/n',
    VALKEY_URL: 'rediss://valkey.invalid:6379',
    ...extra,
  };
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Resolved configuration, with a clean environment so local overrides do not leak in. */
function composeConfig(
  files: string[],
  extraArgs: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
): ComposeConfig {
  const args = ['compose', ...files.flatMap((f) => ['-f', f]), ...extraArgs, 'config'];
  const output = execFileSync('docker', [...args, '--format', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(extraEnv),
  });
  return JSON.parse(output) as ComposeConfig;
}

/** Compose duration ("45s", "1m30s") in milliseconds. */
function durationMs(value: string | undefined): number {
  let total = 0;
  for (const [, amount, unit] of (value ?? '').matchAll(/(\d+)(ms|s|m|h)/g)) {
    total += Number(amount) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as 'ms'];
  }
  return total;
}

describe.skipIf(!dockerComposeAvailable())('Compose files', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ns-compose-'));
  const envFile = path.join(tmp, 'app.env');
  writeFileSync(envFile, 'LOG_LEVEL=warn\nRESEND_MAIN_API_KEY=placeholder\n');
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('compose.yaml alone (stage/production) holds only app services and publishes only the API', () => {
    const { services } = composeConfig(['compose.yaml']);
    expect(Object.keys(services).sort()).toEqual(['api', 'dispatcher', 'migrate', 'worker-email']);
    expect(services.api?.ports?.map((p) => p.target)).toEqual([3000]);
    for (const name of ['migrate', 'dispatcher', 'worker-email']) {
      expect(services[name]?.ports ?? []).toEqual([]);
    }
    expect(services.api?.environment).toMatchObject({
      APP_ENV: 'production',
      DATABASE_SSL: 'true',
    });
  });

  it('checks dispatcher/worker readiness on the ops port without making anything wait on it', () => {
    const { services } = composeConfig(['compose.yaml', 'compose.override.yaml']);
    for (const name of ['dispatcher', 'worker-email']) {
      expect(services[name]?.environment?.OPS_PORT).toBe('9100');
      expect(services[name]?.healthcheck?.test?.join(' ')).toContain('/health/ready');
    }
    for (const service of Object.values(services)) {
      for (const [dependency, { condition }] of Object.entries(service.depends_on ?? {})) {
        if (dependency === 'dispatcher' || dependency === 'worker-email') {
          expect(condition).not.toBe('service_healthy');
        }
      }
    }
  });

  it('binds every locally published port to 127.0.0.1', () => {
    const { services } = composeConfig(['compose.yaml', 'compose.override.yaml']);
    const ports = Object.values(services).flatMap((s) => s.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port.host_ip).toBe('127.0.0.1');
    expect(services.api?.ports?.map((p) => p.target).sort()).toEqual([3000, 9100]);
  });

  it('keeps config-apply behind the tools profile', () => {
    const { services } = composeConfig(
      ['compose.yaml', 'compose.override.yaml'],
      ['--profile', 'tools'],
    );
    expect(services['config-apply']?.profiles).toEqual(['tools']);
    expect(composeConfig(['compose.yaml', 'compose.override.yaml']).services).not.toHaveProperty(
      'config-apply',
    );
  });

  it('passes the stage/production env_file to every app service, with APP_ENV=production', () => {
    const { services } = composeConfig(['compose.yaml'], [], { NOTIFICATION_ENV_FILE: envFile });
    for (const name of APP_SERVICES) {
      expect(services[name]?.environment).toMatchObject({
        APP_ENV: 'production',
        DATABASE_SSL: 'true',
        SECRETS_DIR: '/run/secrets',
        LOG_LEVEL: 'warn',
        RESEND_MAIN_API_KEY: 'placeholder',
      });
    }
    // Without the file (required: false) the configuration is still valid.
    expect(composeConfig(['compose.yaml']).services.api?.environment).not.toHaveProperty(
      'LOG_LEVEL',
    );
  });

  it('never loads the env_file locally and sets APP_ENV=local on every app service', () => {
    const { services } = composeConfig(['compose.yaml', 'compose.override.yaml'], [], {
      NOTIFICATION_ENV_FILE: envFile,
    });
    for (const name of APP_SERVICES) {
      expect(services[name]?.environment?.APP_ENV).toBe('local');
      expect(services[name]?.environment).not.toHaveProperty('RESEND_MAIN_API_KEY');
    }
  });

  it('restarts long-running services and lets the app grace period end before SIGKILL', () => {
    for (const env of [{}, { SHUTDOWN_GRACE_MS: '50000', STOP_GRACE_PERIOD: '1m' }]) {
      const { services } = composeConfig(['compose.yaml'], [], env);
      expect(services.migrate?.restart).toBe('no');
      for (const name of ['api', 'dispatcher', 'worker-email']) {
        const service = services[name];
        expect(service?.restart).toBe('unless-stopped');
        const graceMs = Number(service?.environment?.SHUTDOWN_GRACE_MS);
        expect(graceMs).toBeGreaterThanOrEqual(30_000 + 5_000); // WORKER_SEND_TIMEOUT_MS + margin
        expect(durationMs(service?.stop_grace_period)).toBeGreaterThanOrEqual(graceMs + 5_000);
      }
    }
  });

  it('mounts the example provider secrets into the services that resolve them', () => {
    const { services } = composeConfig(['compose.yaml', 'compose.secrets.example.yaml'], [], {
      SECRETS_HOST_DIR: tmp,
    });
    for (const name of ['api', 'dispatcher', 'worker-email']) {
      expect(services[name]?.secrets?.map((s) => s.target)).toContain(
        '/run/secrets/resend_main_api_key',
      );
    }
    expect(services.migrate?.secrets ?? []).toEqual([]);
  });
});
