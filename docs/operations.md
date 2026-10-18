# Operatività del notification-service

Guida pratica per avviare, configurare e gestire il servizio. Il progetto è descritto in [notification-service-design.md](notification-service-design.md), mentre comandi e struttura del codice sono nel [README](../README.md).

## Ambienti

| Ambiente           | File Compose                                         | PostgreSQL / Valkey                                | Note                                                                |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| Locale             | `compose.yaml` + `compose.override.yaml` (implicito) | container locali (`postgres:18.6`, `valkey:9.1.2`) | Mailpit per le email; porte pubblicate solo su `127.0.0.1`          |
| Stage / produzione | solo `compose.yaml` (`-f compose.yaml`)              | servizi esterni gestiti, raggiunti tramite TLS     | `APP_ENV=stage\|production`; solo l'API va esposta, tramite ingress |

### Locale

```sh
docker compose up --build -d                  # stack completo
docker compose run --rm config-apply          # tenant, chiave API, istanza Mailpit (non serve Node sull'host)
scripts/smoke-local.sh                        # smoke test da zero in un progetto isolato (ns-smoke)
```

Si possono cambiare le porte pubblicate sull'host, per esempio per avviare un secondo progetto isolato con `-p <nome>`. Le variabili sono `POSTGRES_PUBLISHED_PORT` (5432), `VALKEY_PUBLISHED_PORT` (6379), `MAILPIT_SMTP_PUBLISHED_PORT` (1025), `MAILPIT_UI_PUBLISHED_PORT` (8025), `API_PUBLISHED_PORT` (3000) e `API_OPS_PUBLISHED_PORT` (9100). `scripts/smoke-local.sh` usa di default porte diverse (15432, 16379, 11025, 18025, 13000, 19100) e l'immagine `notification-service:smoke`. Il progetto viene rimosso con `down -v` a fine esecuzione, a meno di usare `--keep`.

### Stage e produzione

La configurazione sta in un file env fuori dal repository (`.env.*` è ignorato da git), per esempio `.env.production` con permessi `0600`:

```sh
# .env.production (solo segnaposto)
APP_ENV=production
NOTIFICATION_SERVICE_IMAGE=<registry>/notification-service:<versione>
DATABASE_URL=postgres://<utente>:<password>@<host>:5432/<db>
VALKEY_URL=rediss://<utente>:<password>@<host>:6379
LOG_LEVEL=info
RESEND_MAIN_API_KEY=<segreto>          # solo se si usano riferimenti env:
# tuning opzionale: WORKER_SEND_TIMEOUT_MS=..., DATABASE_POOL_MAX=..., ecc.
```

```sh
docker compose --env-file .env.production -f compose.yaml run --rm migrate   # una volta per deploy
docker compose --env-file .env.production -f compose.yaml up -d
# stage: NOTIFICATION_ENV_FILE=.env.stage docker compose --env-file .env.stage -f compose.yaml up -d
```

- Lo stesso file serve a due cose: `--env-file` alimenta l'interpolazione di `compose.yaml` (immagine, `APP_ENV`, `DATABASE_SSL`, `SHUTDOWN_GRACE_MS`, `STOP_GRACE_PERIOD`, `OPS_*`), mentre `env_file` (percorso `NOTIFICATION_ENV_FILE`, default `.env.production`, opzionale) passa tutte le variabili ai container: URL, tuning e segreti `env:`. Le variabili elencate sotto `environment` in `compose.yaml` prevalgono su `env_file`, quindi vanno impostate tramite interpolazione (`--env-file` o shell). Senza `--env-file`, un `APP_ENV=stage` scritto solo nel file viene ignorato e resta `production`.
- `APP_ENV` è obbligatoria per l'applicazione; `compose.yaml` la imposta a `production` se non indicata, `compose.override.yaml` a `local`. In locale `env_file` è disattivato (`!reset`), quindi un `.env.production` presente sull'host non viene letto.
- **Docker secrets** (riferimenti `file:`): `compose.secrets.example.yaml` mostra il modello. Si copia (per esempio in `compose.secrets.yaml`), si adattano i nomi alle istanze provider e si aggiunge con `-f compose.secrets.yaml`; i file stanno in `SECRETS_HOST_DIR`, fuori dal repository, leggibili dall'utente `node` (uid 1000) del container. Vengono montati in `/run/secrets` (`SECRETS_DIR`) per `api`, `dispatcher` e `worker-email`.

- **PostgreSQL**: TLS obbligatorio. Con `APP_ENV=stage|production` la configurazione rifiuta `DATABASE_SSL=false` e il processo esce con codice 1. Con `DATABASE_SSL=true` il certificato viene verificato (`rejectUnauthorized: true`), quindi deve essere valido per l'host di `DATABASE_URL`.
- **Valkey**: usare `rediss://`. L'istanza deve essere dedicata alle code, con `maxmemory-policy noeviction`, persistenza AOF (`appendonly yes`, `appendfsync everysec` o più restrittivo) e volume persistente. Con un'altra policy di eviction BullMQ può perdere job e lock senza alcun errore. Vanno monitorati memoria usata e scritture rifiutate (`OOM command not allowed`).
- **Rete**: solo l'API (porta 3000) passa dall'ingress. La porta ops (`OPS_PORT`, default 9100) resta sulla rete interna e non è pubblicata da `compose.yaml`.
- **Segreti provider**: Docker secrets montati in `/run/secrets` (`SECRETS_DIR`) oppure variabili d'ambiente nel file env, referenziati da `secretRef` (vedi [Configurazione](#configurazione-tenant-e-chiavi-api)). Non vanno mai inseriti nei file versionati.

## Variabili d'ambiente

Il riferimento con valori segnaposto è [`.env.example`](../.env.example). La validazione avviene all'avvio (`src/config/env.ts`): un valore mancante o non valido fa uscire il processo con codice 1.

| Variabile                 | Default            | Note                                                                  |
| ------------------------- | ------------------ | --------------------------------------------------------------------- |
| `APP_ENV`                 | — (obbligatoria)   | `local`, `test`, `stage`, `production` (`compose.yaml`: `production`) |
| `LOG_LEVEL`               | `info`             | livelli pino; i log sono redatti (niente token, destinatari o corpi)  |
| `HTTP_HOST` / `HTTP_PORT` | `0.0.0.0` / `3000` | API pubblica                                                          |
| `OPS_HOST` / `OPS_PORT`   | `0.0.0.0` / `9100` | server ops interno (`/metrics`, health di worker e dispatcher)        |
| `DATABASE_URL`            | —                  | obbligatoria, `postgres://…`                                          |
| `DATABASE_SSL`            | `false`            | obbligatoriamente `true` in stage/produzione (`compose.yaml`: `true`) |
| `DATABASE_POOL_MAX`       | `10`               | connessioni per processo: dimensionare rispetto a `max_connections`   |
| `VALKEY_URL`              | —                  | obbligatoria; `rediss://` obbligatorio in stage/produzione            |
| `SECRETS_DIR`             | —                  | directory dei Docker secrets (`compose.yaml`: `/run/secrets`)         |
| `OUTBOX_BACKLOG_LIMIT`    | `10000`            | oltre questo backlog l'API non è pronta                               |
| `SHUTDOWN_GRACE_MS`       | `40000`            | periodo di grazia dopo SIGTERM; vedi [Shutdown](#shutdown-e-sigterm)  |
| `STOP_GRACE_PERIOD`       | `45s`              | solo Compose (`stop_grace_period`): attesa prima del SIGKILL          |
| `NOTIFICATION_ENV_FILE`   | `.env.production`  | solo Compose: `env_file` opzionale dei servizi applicativi            |

### Timeout PostgreSQL

`pg` di default attende all'infinito: una connessione che smette di rispondere (failover, host irraggiungibile senza RST) bloccherebbe query e processo. `src/infrastructure/database/orm-config.ts` imposta per ogni connessione:

| Parametro                                      | Valore | Effetto                                                                                         |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `connectionTimeoutMillis`                      | 10 s   | connessione TCP/TLS + startup, e attesa di un client libero nel pool                            |
| `statement_timeout` (server)                   | 15 s   | il server annulla lo statement (errore `57014`); la connessione resta utilizzabile              |
| `query_timeout` (client)                       | 20 s   | il client rinuncia se il server non risponde affatto; la connessione viene distrutta e scartata |
| `idle_in_transaction_session_timeout` (server) | 60 s   | chiude le sessioni ferme dentro una transazione, liberando i lock                               |
| `idleTimeoutMillis` (pool)                     | 30 s   | chiusura dei client inattivi                                                                    |
| TCP keepalive                                  | 10 s   | rileva peer morti anche su connessioni inattive                                                 |

Per ora sono costanti nel codice; diventeranno variabili `DATABASE_*_MS` validate in `src/config/env.ts`. `migrate` usa timeout più lunghi (statement 15 min) e un pool di almeno due connessioni. Con PgBouncer in transaction mode, verificare che accetti i parametri di startup (`statement_timeout`, `idle_in_transaction_session_timeout`).

### Parametri di tuning (lease, timeout, limiti)

Tutte opzionali; i default corrispondono al comportamento verificato dai test. Riferimento completo e commentato: `.env.example`. Combinazioni non valide fanno uscire il processo con `ConfigError`.

| Area            | Variabili (default)                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingresso API    | `INGRESS_RATE_LIMIT` (100) per `INGRESS_RATE_WINDOW_MS` (1000) per tenant; `WEBHOOK_RATE_LIMIT` (200) per `WEBHOOK_RATE_WINDOW_MS` (1000) per istanza                                                                                                      |
| Worker          | `DELIVERY_LEASE_MS` (60000, min 3000), `WORKER_SEND_TIMEOUT_MS` (30000), `WORKER_CONCURRENCY` (10), `LIMITS_BACKEND_TIMEOUT_MS` (2000)                                                                                                                     |
| Limiti provider | `PROVIDER_RATE_LIMIT_BURST` (20), `PROVIDER_RATE_LIMIT_PER_SECOND` (10); `CIRCUIT_BREAKER_FAILURE_THRESHOLD` (5), `CIRCUIT_BREAKER_FAILURE_WINDOW_MS` (30000), `CIRCUIT_BREAKER_OPEN_MS` (30000)                                                           |
| Retry           | `RETRY_BACKOFF_BASE_MS` (5000), `RETRY_BACKOFF_MAX_MS` (300000), `RETRY_JITTER_RATIO` (0.5)                                                                                                                                                                |
| Dispatcher      | `DISPATCHER_POLL_INTERVAL_MS` (1000), `DISPATCHER_BATCH_SIZE` (100), `DISPATCHER_MAX_BATCHES_PER_CYCLE` (20), `OUTBOX_LEASE_MS` (30000), `QUEUE_PUBLISH_TIMEOUT_MS` (3000)                                                                                 |
| Riconciliazione | `RECONCILE_INTERVAL_MS` (10000), `RECONCILE_BATCH_SIZE` (100), `LOST_PUBLICATION_AFTER_MS` (300000), `UNKNOWN_CHECK_INTERVAL_MS` (60000), `UNKNOWN_REPLAY_DELAY_MS` (30000), `PROVIDER_EVENT_ORPHAN_AFTER_MS` (3600000), `PROVIDER_EVENT_BATCH_SIZE` (200) |

Vincoli reciproci: `RETRY_BACKOFF_BASE_MS ≤ RETRY_BACKOFF_MAX_MS`; `QUEUE_PUBLISH_TIMEOUT_MS < OUTBOX_LEASE_MS`; `DELIVERY_LEASE_MS ≥ 3 × LIMITS_BACKEND_TIMEOUT_MS`; `PROVIDER_EVENT_ORPHAN_AFTER_MS ≥ 3 × RECONCILE_INTERVAL_MS`; `LOST_PUBLICATION_AFTER_MS ≥ 2 × DISPATCHER_POLL_INTERVAL_MS`. Il timeout provider può superare il lease: durante l'invio il lease viene rinnovato ogni terzo della sua durata; un `sending` con lease scaduto diventa `unknown` e non viene reinviato.

Limiti per singola istanza provider (prevalgono sui default) nel file di `config:apply`:

```json
{
  "sendRateLimit": { "burst": 20, "perSecond": 10 },
  "circuitBreaker": { "failureThreshold": 5, "failureWindowMs": 30000, "openMs": 30000 }
}
```

### Protezione dell'ingresso

| Variabile                                             | Default       | Effetto                                                                                                       |
| ----------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `AUTH_FAILURE_RATE_LIMIT` / `_WINDOW_MS`              | 30 / 60000    | fallimenti di autenticazione o firma webhook per IP client, prima del lookup DB                               |
| `READ_RATE_LIMIT` / `_WINDOW_MS`                      | 300 / 1000    | richieste di lettura per tenant                                                                               |
| `WEBHOOK_INVALID_RATE_LIMIT` / `_WINDOW_MS`           | 50 / 60000    | webhook non verificati per istanza; non consumano il budget dei webhook validi                                |
| `HTTP_REQUEST_TIMEOUT_MS` / `HTTP_HANDLER_TIMEOUT_MS` | 30000 / 30000 | timeout richiesta; un handler bloccato risponde 503 `dependency_unavailable`                                  |
| `HTTP_TRUST_PROXY`                                    | non impostata | **da impostare dietro l'ingress** (hop o CIDR), altrimenti i limiti per IP usano l'indirizzo dell'ingress     |
| `PROVIDER_ALLOWED_HOSTS`                              | non impostata | host SMTP / Resend consentiti (`host` esatto o `.suffisso`); warning all'avvio se assente in stage/produzione |

- Il mittente (`content.from`) deve essere **una sola** casella (`a@b.c`, `Nome <a@b.c>`): liste, più indirizzi o caratteri di controllo sono rifiutati con 400; policy dei mittenti e trasporto usano lo stesso indirizzo analizzato.
- Fuori da `local`/`test` gli adapter rifiutano anche a runtime le istanze con profilo `local` (quarantena), indipendentemente da come sono state salvate.
- In stage/produzione `SHUTDOWN_GRACE_MS` (default 40000) deve superare `WORKER_SEND_TIMEOUT_MS + 2 × LIMITS_BACKEND_TIMEOUT_MS`.

## Migrazioni

- Il servizio one-shot `migrate` (`node dist/entrypoints/migrate.js`) applica le migrazioni ed esce con codice 0. `api`, `dispatcher` e `worker-email` partono solo dopo il suo completamento (`service_completed_successfully`).
- `migrate` prende un advisory lock PostgreSQL dedicato (`pg_advisory_lock`, sessione di una connessione riservata) per tutta la durata di `migrator.up()`. Due esecuzioni concorrenti (per esempio due host che avviano lo stack insieme) si serializzano: la seconda attende, non trova migrazioni pendenti ed esce con 0. Il lock si rilascia anche se il processo muore, perché è legato alla sessione.
- Resta preferibile eseguire `migrate` una volta per deploy (`docker compose --env-file .env.production -f compose.yaml run --rm migrate`), poi aggiornare i servizi; le applicazioni non migrano all'avvio.
- Le migrazioni devono restare compatibili con la versione precedente dell'applicazione finché il rollout non è completo (prima si aggiunge, poi si rimuove in un rilascio successivo).
- Dall'host: `npm run db:migrate` (legge `.env`).

## Configurazione tenant e chiavi API

`config:apply` applica un file JSON con tenant, mittenti consentiti, chiavi API, istanze provider e policy di routing. È idempotente: rieseguirlo con lo stesso file non cambia nulla.

```sh
docker compose run --rm config-apply                                  # locale, config/local.example.json
docker compose run --rm config-apply --file /config/<altro>.json      # qualsiasi file sotto ./config
npm run config:apply -- --file config/local.example.json             # dall'host
```

In stage/produzione il servizio `config-apply` non esiste, perché è definito solo in `compose.override.yaml`. Si esegue l'immagine con un file montato: `docker compose --env-file .env.production -f compose.yaml run --rm -v <dir>:/config:ro --entrypoint node migrate dist/entrypoints/config-apply.js --file /config/<file>.json`. Le istanze con profilo `local` vengono rifiutate.

**Chiavi API**

- Una chiave nuova viene stampata **una sola volta** su stdout (`API key created for tenant "<slug>" (<nome>): ns_…`). Nel database finisce solo l'hash SHA-256. La chiave va copiata subito in un secret manager, e stdout non deve finire in log persistenti o condivisi.
- Le chiavi esistenti non vengono mai ruotate automaticamente: rieseguire `config:apply` non genera chiavi nuove per nomi già presenti.
- **Rotazione**: (1) aggiungere al file una chiave con un nome nuovo e applicarlo; la nuova chiave viene stampata; (2) distribuirla ai client; (3) impostare `"revoked": true` sulla vecchia chiave e riapplicare. Anche `expiresAt` limita la validità. Le operazioni restano nella tabella `audit_events`.
- In caso di compromissione si revoca subito la chiave (passo 3), poi se ne crea una nuova.
- La revoca è **definitiva**: un file con `"revoked": false` per una chiave già revocata viene rifiutato; serve una chiave con un nome nuovo.
- `config:apply` è atomico (una sola transazione, serializzata con advisory lock): se fallisce non resta nulla di applicato, e le chiavi nuove vengono stampate solo dopo il commit.

**Segreti provider** (`secretRef`): `env:<PREFISSO>` legge `<PREFISSO>_<CHIAVE>` (per esempio `env:RESEND_MAIN` + `apiKey` → `RESEND_MAIN_API_KEY`); `file:<nome>` legge `<SECRETS_DIR>/<nome>_<chiave>` (per esempio `/run/secrets/resend_main_api_key`).

## Webhook provider

- Endpoint: `POST /v1/webhooks/:providerType/:instanceId`, dove `instanceId` è l'id dell'istanza provider in `provider_instances`. Il tenant si ricava dall'istanza e mai dal payload.
- Resend: nella dashboard si registra l'URL pubblico dell'endpoint e si salva il signing secret come segreto `webhookSecret` dell'istanza (per esempio `RESEND_MAIN_WEBHOOK_SECRET`, oppure `/run/secrets/resend_main_webhook_secret`).
- La firma Svix viene verificata sul corpo originale, con una tolleranza di 5 minuti sul timestamp e corpo massimo di 256 KiB. Il servizio risponde 2xx solo dopo aver salvato l'evento in `provider_events`, e i duplicati validi ricevono comunque 2xx. Webhook con firma errata o timestamp scaduto vengono rifiutati.
- Per SMTP generico non ci sono webhook: la ricevuta resta `unavailable`.

## Coda operativa `unknown`

Una delivery va in `unknown` quando il provider potrebbe aver accettato il messaggio: timeout di lettura, reset dopo la trasmissione, risposta non interpretabile, oppure crash fra la chiamata e il salvataggio dell'esito.

- **Resend**: il riconciliatore prova prima a risolvere l'esito tramite webhook o stato del provider. Se non ci riesce, ripete l'invio con la stessa chiave di idempotenza, ma solo entro la finestra garantita (24 ore meno un margine), entro il budget e prima della scadenza. Oltre quella finestra non ripete in automatico.
- **SMTP**: non esiste idempotenza, quindi un nuovo invio potrebbe duplicare il messaggio. La delivery resta `unknown` e va gestita **a mano**.
- Consultazione: `GET /v1/notifications?status=unknown` per tenant, oppure query sulla tabella `deliveries` per una vista globale. Il retry ordinario (`POST /v1/notifications/:id/retry`) rifiuta le delivery `unknown`. Si verifica l'esito presso il destinatario o nei log del provider. Un eventuale reinvio va fatto come nuova notifica, con una nuova Idempotency-Key, ed è una decisione esplicita dell'operatore.
- Una crescita del numero di `unknown` va trattata come un allarme: di solito indica timeout provider troppo bassi o un provider degradato.

## Perdita e ripristino di Valkey

La fonte di verità è PostgreSQL. Valkey contiene solo job in coda, lock e contatori (rate limit, circuit breaker).

- Se Valkey non è disponibile, il dispatcher non pubblica e lascia gli eventi outbox ripubblicabili. I worker sospendono gli invii, perché non possono acquisire capacità dal limiter. L'API continua ad accettare richieste, che si accumulano nell'outbox. Oltre `OUTBOX_BACKLOG_LIMIT` l'API risulta non pronta.
- Se i dati vanno persi (FLUSH, volume perso, failover senza AOF), il riconciliatore del dispatcher ripubblica le delivery ancora eseguibili. I job duplicati o obsoleti vengono scartati dal controllo su generazione e lease, e le delivery `accepted` non vengono reinviate. Rate limit e circuit breaker ripartono da zero.
- Dopo il ripristino, verificare che backlog outbox ed età del più vecchio evento tornino a scendere.

## Backup e ripristino di PostgreSQL

- Backup regolari con test di ripristino, volumi cifrati e accessi limitati.
- **Attenzione**: un ripristino a uno stato precedente può "dimenticare" invii già avvenuti. Le delivery che risultano `pending`/`sending`/`retry_wait` nel backup potrebbero essere già state accettate dal provider dopo l'istante del backup.
- Procedura: (1) fermare `dispatcher` e `worker-email` e lasciarli fermi; (2) ripristinare il database; (3) svuotare Valkey (FLUSHDB del DB delle code), così non restano job riferiti allo stato successivo al backup; (4) riconciliare le finestre incerte, cioè le delivery create o modificate fra il backup e l'incidente, usando log provider, webhook e Mailpit/caselle. Le delivery già inviate vanno portate a uno stato terminale prima di riattivare i worker; (5) riavviare `api`, poi `dispatcher` e `worker-email`.

## Shutdown e SIGTERM

`docker compose stop` (o un rollout) invia SIGTERM. I processi smettono di acquisire nuovo lavoro, attendono le operazioni in corso, poi chiudono code, connessioni e ORM.

- **Codici di uscita**: 0 se tutto si chiude entro `SHUTDOWN_GRACE_MS` (eventuali errori di chiusura sono solo registrati); **1** se il periodo di grazia scade. In quel caso gli invii ancora in corso restano `sending` e il riconciliatore li porta in `unknown` alla scadenza del lease, senza mai dichiararli riusciti. Lo stesso accade se Docker invia SIGKILL dopo `stop_grace_period`.
- **Relazione fra i tempi**: `stop_grace_period` (`STOP_GRACE_PERIOD`, default 45 s) > `SHUTDOWN_GRACE_MS` (default 40 s) > `WORKER_SEND_TIMEOUT_MS` (30 s) + margine per chiudere code e ORM. In stage/produzione la configurazione rifiuta `SHUTDOWN_GRACE_MS ≤ WORKER_SEND_TIMEOUT_MS + 2 × LIMITS_BACKEND_TIMEOUT_MS`; il vincolo con `stop_grace_period` lo verifica solo `tests/integration/infra/compose.test.ts`, con i valori di default. Se si alza il timeout provider vanno alzati anche gli altri due, impostandoli tramite interpolazione (`--env-file` o shell), non solo in `env_file`.
- **Errori fatali**: una promise rifiutata senza gestione o un'eccezione non catturata viene registrata come `fatal` e il processo esce subito con 1, senza eseguire le chiusure; la restart policy lo riavvia e lease e riconciliazione recuperano il lavoro in corso.
- Durante lo shutdown non si registrano invii fittiziamente riusciti.

## Server ops, health e metriche

Ogni processo espone un server HTTP interno su `OPS_HOST:OPS_PORT` (default `0.0.0.0:9100`):

- `GET /metrics`: metriche Prometheus, su tutti i processi.
- `GET /health/live` e `GET /health/ready`: su dispatcher e worker, che sono pronti solo con database e Valkey utilizzabili. L'API espone invece `/health/live` e `/health/ready` sulla porta pubblica, ed è pronta con database e configurazione disponibili e backlog outbox sotto `OUTBOX_BACKLOG_LIMIT` (contati solo gli eventi già dovuti: retry e rinvii futuri non bloccano l'API). Il dispatcher aggiunge il check `loops` (pubblicazione e riconciliazione girano in loop indipendenti; non pronto se un loop non completa un ciclo entro max(30 s, 5×poll, 2×`OUTBOX_LEASE_MS`)); il worker aggiunge `jobs` (non pronto se un job in corso supera max(60 s, 2×(send timeout + lease))). Oltre una soglia più alta il processo registra un errore fatale ed esce con 1.
- Healthcheck Docker: per l'API l'immagine controlla `/health/live` su `HTTP_PORT`. Per `dispatcher` e `worker-email`, `compose.yaml` controlla `/health/ready` su `OPS_PORT` con `node -e fetch(…)` (l'immagine slim non contiene curl). Nessun `depends_on` attende questi healthcheck.
- Il server ops non va esposto tramite ingress. In locale la porta ops dell'API è pubblicata su `127.0.0.1:${API_OPS_PUBLISHED_PORT:-9100}`.
- **Riavvio**: i servizi hanno `restart: unless-stopped` (`migrate`: `no`), quindi Compose li riavvia quando il processo esce, con qualsiasi codice. Compose **non** riavvia un container solo perché è `unhealthy`: per questo dispatcher e worker, se un loop interno resta bloccato, escono da soli con codice 1 e la restart policy li recupera. Con un orchestratore (Kubernetes, Nomad, Swarm con agent esterni) usare `/health/live` come liveness e `/health/ready` come readiness: sulla porta ops (`OPS_PORT`) per dispatcher e worker, sulla porta HTTP per l'API. Una readiness fallita deve togliere traffico, non riavviare.

### Metriche esposte

Ogni processo espone `GET /metrics` sul server ops (`OPS_HOST:OPS_PORT`, mai tramite ingress) con label `service` (`api`, `worker`, `dispatcher`) e le metriche standard `process_*`/`nodejs_*`. Nessuna label contiene destinatari, ID di notifica/consegna o tenant; i tipi provider fuori dall'elenco noto diventano `other`.

| Metrica                                                                                           | Tipo      | Label                       | Allarme suggerito                       |
| ------------------------------------------------------------------------------------------------- | --------- | --------------------------- | --------------------------------------- |
| `notifications_api_requests_accepted_total`                                                       | counter   | operation                   |                                         |
| `notifications_api_requests_rejected_total`                                                       | counter   | operation, reason           | picco di `unauthorized`/`rate_limited`  |
| `notifications_webhooks_received_total`                                                           | counter   | provider_type               |                                         |
| `notifications_webhooks_invalid_total`                                                            | counter   | provider_type, reason       | `invalid_signature` > 0 sostenuto       |
| `notifications_time_to_first_attempt_seconds`                                                     | histogram | channel                     | p95 > 60 s                              |
| `notifications_provider_call_duration_seconds`                                                    | histogram | provider_type, outcome      | p95 vicino a `WORKER_SEND_TIMEOUT_MS`   |
| `notifications_retries_scheduled_total`                                                           | counter   | channel, provider_type      | tasso in crescita                       |
| `notifications_fallbacks_total`                                                                   | counter   | channel, from_provider_type | > 0 (provider primario degradato)       |
| `notifications_unknown_transitions_total`                                                         | counter   | source                      | > 0: richiede gestione operativa        |
| `notifications_final_outcomes_total`                                                              | counter   | channel, outcome            | rapporto `failed` anomalo               |
| `notifications_outbox_published_total`                                                            | counter   | —                           |                                         |
| `notifications_outbox_publish_failures_total`                                                     | counter   | reason                      | > 0 per più minuti (Valkey)             |
| `notifications_reconciliation_results_total`                                                      | counter   | result                      | `step_failed` > 0                       |
| `notifications_outbox_pending_events`                                                             | gauge     | —                           | vicino a `OUTBOX_BACKLOG_LIMIT`         |
| `notifications_outbox_oldest_pending_age_seconds`                                                 | gauge     | —                           | > 60 s                                  |
| `notifications_valkey_memory_used_bytes` / `_max_bytes`                                           | gauge     | —                           | > 80% di maxmemory                      |
| `notifications_db_pool_connections`, `_max_connections`, `_waiting_requests`, `_saturation_ratio` | gauge     | state                       | saturazione > 0.9 o richieste in attesa |
| `notifications_queue_jobs`                                                                        | gauge     | queue, state                | `failed` in crescita                    |

## Retention: NON implementata (pre-produzione)

Il servizio oggi **non elimina né anonimizza nulla**: notifiche, destinatari, tentativi, eventi provider e audit crescono senza limite. Va implementata (job periodico configurabile) e decisa prima della produzione. Proposta del progetto:

| Dati                                                           | Conservazione                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Contenuti e destinatari delle notifiche                        | 30 giorni                                                         |
| Dati operativi minimizzati (stati, tentativi, eventi provider) | 90 giorni                                                         |
| Log applicativi                                                | 14 giorni                                                         |
| Job BullMQ completati/falliti                                  | limitati per numero ed età; la cronologia autorevole resta nel DB |

Le informazioni necessarie a risolvere lavorazioni aperte (`unknown`, `retry_wait`, webhook non associati) non vanno eliminate. Dopo la scadenza i dati vanno anonimizzati, mantenendo i tombstone di idempotenza fino al loro termine.

## Checklist pre-produzione

Corrisponde al gate finale del progetto (scenari di accettazione e requisiti operativi).

- [ ] CI verde: `quality`, `integration`, `docker` e `e2e`, cioè i 12 scenari di accettazione, sull'ultimo commit di `main`.
- [ ] Migrazioni applicate da zero su un database vuoto e sullo schema precedente; `migrate` eseguito una sola volta per deploy (il lock advisory protegge comunque da esecuzioni concorrenti).
- [ ] File env di stage/produzione fuori dal repository (`0600`), passato sia con `--env-file` sia come `env_file`; `APP_ENV` esplicita.
- [ ] PostgreSQL esterno con TLS verificato (`DATABASE_SSL=true`), backup attivi e ripristino provato.
- [ ] Valkey dedicato, raggiunto con `rediss://`, con `noeviction`, AOF e volume persistente; monitoraggio di memoria e scritture rifiutate.
- [ ] Solo l'API è esposta tramite ingress (TLS); porta ops e infrastruttura solo su rete interna.
- [ ] Segreti provider in Docker secrets o secret manager; nessuna istanza con profilo `local`; SMTP con TLS obbligatorio.
- [ ] Chiavi API generate con `config:apply`, salvate in un secret manager, procedura di revoca provata.
- [ ] Webhook Resend registrati, segreto di firma configurato, endpoint raggiungibile e firma verificata.
- [ ] Health e metriche raccolte; allarmi su backlog e età outbox, `unknown`, `failed`, webhook non validi, memoria Valkey e pool DB.
- [ ] Procedura per la coda `unknown` (SMTP) assegnata a un responsabile.
- [ ] Shutdown provato: SIGTERM durante un invio lascia uno stato recuperabile (`stop_grace_period` > `SHUTDOWN_GRACE_MS` > `WORKER_SEND_TIMEOUT_MS` + margine).
- [ ] Timeout PostgreSQL verificati con il failover del provider gestito (query bloccate falliscono entro ~20 s).
- [ ] Throughput e latenza misurati con un provider simulato prima di fissare SLA e concorrenza; quote provider configurate.
- [ ] **Retention implementata** (oggi assente) secondo la proposta decisa; log senza PII (redazione verificata).
