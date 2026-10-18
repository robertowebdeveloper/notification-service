# notification-service

Microservizio asincrono di notifiche (email nel primo rilascio; SMS, push e messaggistica previsti nei contratti). Progetto: [docs/notification-service-design.md](docs/notification-service-design.md).

## Stato

Fasi 0–2 completate: contratti, persistenza PostgreSQL (outbox, claim, fencing), adapter email SMTP e Resend con webhook, API `/v1` (auth API key, idempotenza, retry manuale, webhook, rate limit), pipeline di consegna (dispatcher, worker con limiter e circuit breaker, riconciliazione `unknown`, ricevute), suite e2e con i 12 scenari di accettazione. Fase 3: parametri operativi configurabili, limiti per istanza provider, metriche Prometheus e server ops, CI GitHub Actions, script di smoke e runbook (`docs/operations.md`). Prossima fase: revisione indipendente.

## Matrice versioni

| Componente                 | Versione                                                                   |
| -------------------------- | -------------------------------------------------------------------------- |
| Node.js                    | 24.22.0 LTS (`node:24.22.0-trixie-slim`)                                   |
| TypeScript                 | 6.0.3 (limite di typescript-eslint `<6.1`)                                 |
| Fastify                    | 5.12.7, @fastify/swagger 9.9.2, type-provider-typebox 6.3.0, typebox 1.4.2 |
| MikroORM                   | 7.2.5 (core, postgresql, migrations allineati)                             |
| BullMQ / ioredis           | 6.3.16 / 5.11.1                                                            |
| PostgreSQL                 | 18.6 (`postgres:18.6-alpine`, solo locale)                                 |
| Valkey                     | 9.1.2 (`valkey/valkey:9.1.2-alpine`, solo locale)                          |
| Mailpit                    | v1.31.6 (solo locale)                                                      |
| Vitest / ESLint / Prettier | 5.0.5 / 10.13.0 / 3.9.10                                                   |

## Struttura

```text
src/entrypoints/   api.ts, worker.ts, dispatcher.ts, migrate.ts, config-apply.ts
src/config/        validazione environment (TypeBox)
src/contracts/     canali, stati, porta provider, job, schemi HTTP
src/application/   casi d'uso e porte repository
src/infrastructure database/ queue/ providers/ security/ observability/ runtime/
src/http/          app Fastify e route
tests/             unit/ integration/ contract/ e2e/
docker/            Dockerfile, init PostgreSQL locale, secrets (ignorati)
```

## Comandi

```sh
npm ci
npm run build            # tsc -> dist/
npm run typecheck
npm run lint             # eslint + prettier --check
npm run format
npm run test:unit        # anche test:integration, test:contract, test:e2e
npm run db:migrate
npm run dev:api          # anche dev:worker, dev:dispatcher (tsx watch, legge .env)
```

### API e configurazione

- OpenAPI: `GET /v1/openapi.json`. Le route di business sono sotto `/v1`; `/health/live` e `/health/ready` non sono versionate.
- Autenticazione: `Authorization: Bearer ns_<prefisso>_<segreto>`; nel DB è salvato solo l'hash SHA-256.
- Tenant, chiavi API, istanze provider e policy: `npm run config:apply -- --file config/local.example.json`. Idempotente; le chiavi nuove sono stampate una sola volta, quelle esistenti non vengono ruotate. In stage e produzione rifiuta le istanze con profilo `local`.
- In `config/local.example.json` l'host SMTP è `mailpit` (rete Compose); per un worker avviato sull'host usare `localhost`. Nello stack Docker locale: `docker compose run --rm config-apply`.
- Parametri operativi (lease, timeout, limiti, backoff, intervalli) e limiti per istanza provider: `.env.example` e `docs/operations.md`.
- Server ops interno per processo su `OPS_PORT` (default 9100): `/metrics` e, per worker/dispatcher, `/health/ready`. Localmente è pubblicato solo quello dell'API su `127.0.0.1:9100` (`API_OPS_PUBLISHED_PORT`); in produzione non va esposto.

### Smoke test e CI

- `npm run smoke:local`: avvia da zero un progetto Compose isolato (`ns-smoke`, porte 1xxxx), applica la config, invia una email e la verifica in Mailpit, poi rimuove il progetto. Richiede docker, curl, jq.
- CI: `.github/workflows/ci.yml` (qualità, integrazione con servizi Postgres/Valkey, e2e su main/nightly/manuale, build immagine + smoke).
- Runbook operativo: `docs/operations.md`.

### Test e2e

Richiedono `docker compose up -d postgres valkey mailpit`; poi `npm run test:e2e` (seriale, ~15 min). Ogni file usa un DB `notifications_e2e_<slot>` e un indice Valkey dedicati; dettagli in `tests/e2e/README.md`.

## Ambienti Docker

**Sviluppo locale** — `compose.yaml` + `compose.override.yaml` (caricato automaticamente) avviano `migrate`, `api`, `dispatcher`, `worker-email`, più PostgreSQL 18, Valkey (AOF, `noeviction`) e Mailpit. Tutte le porte pubblicate (API inclusa) sono legate a `127.0.0.1`:

```sh
docker compose up --build -d                   # stack completo
docker compose ps                              # migrate: Exited (0); postgres/valkey/api: healthy
curl localhost:3000/health/live                # 200
curl localhost:3000/health/ready               # 200 se il database è raggiungibile
docker compose up -d postgres valkey mailpit   # solo infrastruttura, app sull'host:
cp .env.example .env && npm run db:migrate && npm run dev:api
```

API su `http://localhost:3000`, UI Mailpit su `http://localhost:8025`, SMTP Mailpit su `localhost:1025`. Il database `notifications_test` (creato da `docker/postgres/init/` solo alla prima inizializzazione del volume) e il DB Valkey `1` sono usati dai test d'integrazione; gli smoke test dell'infrastruttura si eseguono con `npm run test:integration -- tests/integration/infra` (variabili `TEST_DATABASE_URL`, `TEST_VALKEY_URL`).

`docker compose stop` invia SIGTERM: api, dispatcher e worker chiudono queue, connessioni e ORM ed escono con codice 0 se ci riescono entro `SHUTDOWN_GRACE_MS` (default 40 s), con codice 1 se il periodo scade (gli invii interrotti restano `sending` e diventano `unknown`). Compose attende `stop_grace_period` (`STOP_GRACE_PERIOD`, default 45 s), che deve superare `SHUTDOWN_GRACE_MS`. `docker compose down -v` elimina anche i volumi PostgreSQL/Valkey.

**Stage e produzione** — PostgreSQL e Valkey sono servizi esterni: si usa soltanto `compose.yaml`, che non contiene infrastruttura (`docker compose -f compose.yaml config --services` elenca solo `migrate`, `api`, `dispatcher`, `worker-email`).

```sh
# .env.production fuori dal repository: APP_ENV, NOTIFICATION_SERVICE_IMAGE, DATABASE_URL,
# VALKEY_URL, tuning, eventuali segreti env:
docker compose --env-file .env.production -f compose.yaml run --rm migrate
docker compose --env-file .env.production -f compose.yaml up -d
# con Docker secrets per i riferimenti file: aggiungere -f compose.secrets.yaml
# (copiato da compose.secrets.example.yaml)
```

Il file è usato sia per l'interpolazione (`--env-file`) sia come `env_file` dei container (`NOTIFICATION_ENV_FILE`, default `.env.production`); dettagli, timeout PostgreSQL e lock delle migrazioni in `docs/operations.md`.

Con `APP_ENV=stage|production` la validazione della configurazione rifiuta `DATABASE_SSL=false` (il processo esce con codice 1 prima di connettersi); con `DATABASE_SSL=true` il driver usa TLS con verifica del certificato (`rejectUnauthorized: true`), quindi il server PostgreSQL deve presentare un certificato valido per l'host di `DATABASE_URL`. Per Valkey usare `rediss://` (TLS). `APP_ENV` è obbligatoria: `compose.yaml` imposta di default `APP_ENV=production` e `DATABASE_SSL=true`, `compose.override.yaml` imposta `local`. `migrate` viene eseguito prima di api/dispatcher/worker e prende un advisory lock, quindi esecuzioni concorrenti si serializzano (la seconda esce con 0). Solo l'API pubblica una porta, da esporre tramite ingress. I segreti provider vanno montati in `/run/secrets` (Docker secrets) o passati nel file env. Le connessioni PostgreSQL hanno keepalive e timeout (connessione 10 s, statement 15 s, lettura client 20 s). **Retention non implementata**: va realizzata prima della produzione (proposta in `docs/operations.md`).
