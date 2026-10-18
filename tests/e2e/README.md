# E2E acceptance suite

Black-box tests for the acceptance scenarios 1–12 in
[`docs/notification-service-design.md`](../../docs/notification-service-design.md#verifica-e-criteri-di-accettazione).
The tests start the real processes (`api`, `dispatcher`, `worker`, `migrate`, `config-apply`) as
child processes. They drive the system over HTTP and check the results through the API,
read-only PostgreSQL queries, Mailpit and fake providers. Fault injection uses only these
mechanisms: SIGKILL/SIGSTOP/SIGTERM on the processes, fake providers that hold or drop their
replies, FLUSHDB on the suite's own Valkey DB index, and setting outbox rows to the state a
crashed dispatcher leaves behind.

## Prerequisites

The local infrastructure from Compose must be running (no app containers needed):

```sh
docker compose up -d postgres valkey mailpit
npm ci
```

The suite never touches the development database or Valkey DB 0/1:

- each scenario file uses its own database `notifications_e2e_<slot>`. The harness creates it
  through `E2E_ADMIN_DATABASE_URL` (the role needs CREATEDB), empties it and migrates it with
  the real `migrate` entrypoint;
- each file also uses its own Valkey DB index `<slot>` (2–14);
- Mailpit is shared, so every message goes to a unique `…@example.test` recipient, and searches
  filter by that recipient. Real recipients are never used;
- the fake SMTP and Resend servers listen on ephemeral loopback ports.

## Running

```sh
npm run test:e2e                                            # whole suite (serial by config)
npx vitest run --project e2e tests/e2e/harness.test.ts      # harness self-tests only
npx vitest run --project e2e tests/e2e/scenarios/s04-crash-after-provider-accept.test.ts
```

The e2e project runs files serially (`fileParallelism: false` in `vitest.config.ts`): the
scenarios measure timing (leases, backoff, Retry-After, rate limits).

## Service tuning

`support/env.ts` (`SERVICE_TUNING`) shortens the runtime settings of `src/config/env.ts` for every
service process. Only the timing knobs change; budgets, fencing and the no-blind-resend rules are
the production ones:

| Variable                                                   | Suite value        | Production default  |
| ---------------------------------------------------------- | ------------------ | ------------------- |
| `DELIVERY_LEASE_MS`                                        | 10000              | 60000               |
| `RECONCILE_INTERVAL_MS`                                    | 1000               | 10000               |
| `LOST_PUBLICATION_AFTER_MS`                                | 15000              | 300000              |
| `UNKNOWN_CHECK_INTERVAL_MS`                                | 2000               | default             |
| `UNKNOWN_REPLAY_DELAY_MS`                                  | 2000               | default             |
| `OUTBOX_LEASE_MS`                                          | 5000               | 30000               |
| `DISPATCHER_POLL_INTERVAL_MS`                              | 250                | 1000                |
| `RETRY_BACKOFF_BASE_MS` / `_MAX_MS` / `RETRY_JITTER_RATIO` | 1000 / 10000 / 0.5 | 5000 / 300000 / 0.5 |

`E2E_SERVICE_ENV` (JSON) overrides any of them, and the `TIMING` budget (recovery wait, settle
window, minimum backoff gap, lost-publication wait) is derived from the effective values. Some
tests add their own settings: S6.2 runs with `DELIVERY_LEASE_MS=6000` and S11.3 with
`SHUTDOWN_GRACE_MS=2000`. Every process gets its own free `HTTP_PORT` (dispatcher and worker
too) and its own `OPS_PORT`, with `OPS_HOST=127.0.0.1`.

## Fault injection used by scenario 10

- S10.1 sets a per-instance `sendRateLimit` (`burst` 2, 2/s) in the config:apply file. With two
  workers, it checks the token-bucket bound on every window of the timestamps recorded by the
  fake provider. It also checks that quota deferrals consume no attempts.
- S10.2 makes the limiter fail without touching the queue. It sets the instance's token-bucket
  key (`ns:ratelimit:{<instanceId>}`, on this file's Valkey DB) to a string, so each limiter
  call gets WRONGTYPE. The test then checks that no provider call or attempt happens while the
  key is broken. After the key is deleted, it checks that the delivery is sent once.

## Configuration (environment variables)

| Variable                        | Default                                                               | Purpose                                                  |
| ------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `E2E_ADMIN_DATABASE_URL`        | `postgres://notifications:notifications@localhost:5432/notifications` | Connection used to create/drop the e2e databases         |
| `E2E_VALKEY_URL`                | `redis://localhost:6379`                                              | Valkey server (the DB index is set per file)             |
| `E2E_MAILPIT_API_URL`           | `http://localhost:8025/api/v1`                                        | Mailpit HTTP API                                         |
| `E2E_MAILPIT_SMTP_HOST`/`_PORT` | `localhost` / `1025`                                                  | Mailpit SMTP, as seen by the services                    |
| `E2E_SERVICE_LOG_LEVEL`         | `debug`                                                               | `LOG_LEVEL` of the child processes                       |
| `E2E_LOG_DIR`                   | unset                                                                 | Writes the full output of every child process there      |
| `E2E_SERVICE_ENV`               | unset                                                                 | JSON object of extra env vars for every service (tuning) |
| `E2E_STARTUP_TIMEOUT_MS`        | `30000`                                                               | Process startup budget                                   |
| `E2E_DELIVERY_TIMEOUT_MS`       | `30000`                                                               | Normal delivery path                                     |
| `E2E_RECOVERY_TIMEOUT_MS`       | `max(60000, 3 × (lease + reconcile))`                                 | Lease expiry + reconciliation (+ backoff)                |
| `E2E_SETTLE_MS`                 | `max(5000, 3 × reconcile)`                                            | Window for "nothing else happens" assertions             |
| `E2E_LEASE_MS`                  | effective `DELIVERY_LEASE_MS`                                         | Delivery lease configured in the services                |
| `E2E_LOST_PUBLICATION_MS`       | effective `LOST_PUBLICATION_AFTER_MS`                                 | Age before lost jobs are re-armed (S7.1)                 |
| `E2E_MIN_BACKOFF_MS`            | `base × (1 − jitter) − 50`                                            | Minimum gap expected between retryable attempts          |
| `E2E_SHUTDOWN_GRACE_MS`         | `10000`                                                               | `SHUTDOWN_GRACE_MS` given to the services                |

When a test times out, the error includes the delivery's DB state (status, attempts, outbox) and
the last output lines of every live process.

## Layout

```text
tests/e2e/
  harness.test.ts            self-tests (fakes, signer, key parser, processes, migrations)
  scenarios/sNN-*.test.ts    one file per acceptance scenario (test names start with SN.x)
  support/
    system.ts                E2eSystem: database, Valkey index, fakes, processes, DB inspection
    lifecycle.ts             useE2eSystem(slot): per-file setup, SIGKILL of all processes per test
    processes.ts             `node --import tsx <entrypoint>` child processes (signals, logs)
    seed.ts                  TenantSeeder interface; ConfigApplySeeder runs `config:apply --file`
    fake-smtp.ts             programmable SMTP provider (accept/4xx/5xx/hang/hold per recipient)
    fake-resend.ts           programmable Resend API (idempotency keys, hold, 409, 429 Retry-After)
    webhooks.ts              Svix-signed Resend webhooks
    queue.ts                 FLUSHDB and duplicate dispatch jobs on the file's Valkey DB
    mailpit.ts, api-client.ts, database.ts, payloads.ts, wait-for.ts, env.ts
  fixtures/config.example.json   format of the tenant file given to config:apply
```

Every test seeds its own tenant through `config:apply`, using a unique slug and the plaintext
API key printed once on stdout. Each test therefore starts with fresh data, without
truncating tables.
