# Schema database

Schema PostgreSQL del servizio, definito a mano nelle migration in `src/infrastructure/database/migrations/` (fonte di verità) e rispecchiato dalle entità MikroORM in `src/infrastructure/database/entities.ts` (verificato da `tests/integration/database/schema.test.ts`).

## Convenzioni

- **Chiavi primarie**: `bigint generated always as identity`. Gli id li assegna solo PostgreSQL (un `insert` con `id` esplicito è rifiutato); l'applicazione li legge con `insert ... returning id`. Nell'API sono numeri JSON interi positivi (esatti fino a 2^53 − 1); nei path (`/v1/notifications/{id}`) sono validati come stringa decimale.
- **Chiavi esterne**: colonne `bigint`. Le relazioni tenant-scoped usano FK composite `(tenant_id, x_id) → (tenant_id, id)`, così una riga non può puntare a dati di un altro tenant.
- **Id sequenziali e unicità globale**: dopo un reset del database (o tra ambienti diversi) gli id si ripetono. Per questo la chiave di idempotenza verso il provider e il `Message-ID` SMTP includono anche l'istante di creazione della notifica.
- **Timestamp**: `timestamptz(3)` (millisecondi, round-trip esatto con `Date` JS, necessario per la paginazione keyset su `created_at, id`).
- **Stati**: `text` + vincoli `CHECK` allineati a `src/contracts/statuses.ts`.
- **Token di lease** (`lease_token`): `uuid` casuali generati dal DB a ogni claim; non sono chiavi ma token di fencing.

## Diagramma ER

```mermaid
erDiagram
    tenants ||--o{ api_keys : "ha"
    tenants ||--o{ provider_instances : "configura"
    tenants ||--o{ routing_policies : "pubblica"
    tenants ||--o{ notifications : "invia"
    tenants ||--o{ suppressions : "blocca"
    tenants |o--o{ audit_events : "traccia"
    routing_policies ||--o{ routing_policy_providers : "ordina"
    provider_instances ||--o{ routing_policy_providers : "usata in"
    routing_policies ||--o{ notifications : "instrada"
    notifications ||--o{ deliveries : "genera"
    deliveries ||--o{ delivery_attempts : "tenta"
    provider_instances ||--o{ delivery_attempts : "esegue"
    deliveries ||--o{ outbox_events : "pubblica"
    provider_instances ||--o{ provider_events : "riceve"
    deliveries |o--o{ provider_events : "correlato a"
    provider_events |o--o{ suppressions : "origina"

    tenants {
        bigint id PK
        text slug UK
        text name
        text status "active | suspended"
        jsonb quotas "limiti e allowedSenders"
        timestamptz created_at
        timestamptz updated_at
    }
    api_keys {
        bigint id PK
        bigint tenant_id FK
        text name "unico per tenant"
        text key_prefix UK
        text key_hash "SHA-256, mai il segreto"
        text_array scopes
        timestamptz created_at
        timestamptz expires_at
        timestamptz revoked_at
        timestamptz last_used_at
    }
    provider_instances {
        bigint id PK
        bigint tenant_id FK
        text name "unico per tenant"
        text provider_type "smtp, resend, ..."
        text channel "email | sms | push | messaging"
        text platform "null per email/sms"
        jsonb config
        text secret_ref "riferimento, mai il segreto"
        boolean enabled
        integer revision
        jsonb limits "sendRateLimit, circuitBreaker"
        timestamptz created_at
        timestamptz updated_at
    }
    routing_policies {
        bigint id PK
        bigint tenant_id FK
        text routing_key
        text channel
        text platform
        integer version "immutabile: nuova versione a ogni modifica"
        boolean enabled
        integer max_attempts "1..100"
        integer ttl_seconds
        boolean fallback_enabled
        timestamptz created_at
    }
    routing_policy_providers {
        bigint routing_policy_id PK, FK
        integer position PK
        bigint tenant_id FK
        bigint provider_instance_id FK
    }
    notifications {
        bigint id PK
        bigint tenant_id FK
        text idempotency_key "unico per tenant"
        text request_hash
        text channel
        text routing_key
        bigint routing_policy_id FK
        jsonb payload
        jsonb metadata
        jsonb routing_snapshot "policy e provider al momento della richiesta"
        timestamptz created_at
    }
    deliveries {
        bigint id PK
        bigint tenant_id FK
        bigint notification_id FK
        text channel
        text recipient
        text submission_status
        text receipt_status
        integer generation "incrementata a ogni retry"
        integer attempts_used
        integer max_attempts
        timestamptz next_attempt_at
        timestamptz expires_at
        uuid lease_token
        timestamptz lease_expires_at
        integer version "fencing"
        text last_error_code
        text last_error_message
        text terminal_reason
        timestamptz created_at
        timestamptz updated_at
    }
    delivery_attempts {
        bigint id PK
        bigint tenant_id FK
        bigint delivery_id FK
        integer attempt_number "unico per delivery"
        integer generation
        bigint provider_instance_id FK
        integer provider_instance_revision
        text provider_idempotency_key
        text outcome "started | accepted | rejected | unknown"
        timestamptz started_at
        timestamptz finished_at
        text error_kind
        text error_code
        text error_message
        text external_reference
    }
    outbox_events {
        bigint id PK
        bigint tenant_id FK
        bigint delivery_id FK
        integer generation
        text event_type "dispatch_delivery"
        text status "pending | publishing | published"
        timestamptz available_at
        uuid lease_token
        timestamptz lease_expires_at
        integer dispatch_count "job id = dispatch-id-count"
        timestamptz published_at
        text last_error
        timestamptz created_at
        timestamptz updated_at
    }
    provider_events {
        bigint id PK
        bigint tenant_id FK
        bigint provider_instance_id FK
        text external_event_id "unico per istanza"
        text external_message_id
        text event_type
        timestamptz occurred_at
        timestamptz received_at
        bigint delivery_id FK "null finché non correlato"
        timestamptz processed_at
        jsonb payload
    }
    suppressions {
        bigint id PK
        bigint tenant_id FK
        text channel
        text recipient_key "unico per tenant e canale"
        text reason "hard_bounce | complaint | manual | unsubscribe"
        text source "provider_event | admin"
        bigint provider_event_id FK
        timestamptz created_at
    }
    audit_events {
        bigint id PK
        bigint tenant_id FK "null per operazioni globali"
        text actor
        text operation
        text resource_type
        text resource_id "id della risorsa come testo"
        jsonb details
        timestamptz occurred_at
    }
```

## Tabelle

| Tabella                    | Ruolo                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`                  | Clienti del servizio; `quotas` contiene limiti e mittenti ammessi (`allowedSenders`). Gestiti da `config:apply`.                                                        |
| `api_keys`                 | Chiavi `ns_<prefisso>_<segreto>`: si salvano prefisso (lookup) e hash SHA-256. Revoca irreversibile.                                                                    |
| `provider_instances`       | Configurazioni dei provider (SMTP, Resend, …) per tenant; `revision` cresce a ogni modifica, i segreti sono solo riferimenti (`secret_ref`).                            |
| `routing_policies`         | Regole `routing_key + channel + platform` → provider, versionate (ogni modifica crea una nuova versione).                                                               |
| `routing_policy_providers` | Ordine dei provider di una versione di policy (posizione 0 = primario, le successive sono fallback).                                                                    |
| `notifications`            | Richiesta accettata dall'API, idempotente su `(tenant_id, idempotency_key)`; conserva payload e snapshot del routing.                                                   |
| `deliveries`               | Stato di consegna verso un destinatario: stato di invio, ricevuta, budget tentativi, lease e fencing (`version`, `generation`).                                         |
| `delivery_attempts`        | Ogni chiamata a un provider, registrata come `started` prima dell'invio; un esito ambiguo resta `unknown` e non viene mai reinviato a un altro provider.                |
| `outbox_events`            | Outbox transazionale: il dispatcher li reclama con `FOR UPDATE SKIP LOCKED` e li pubblica su BullMQ.                                                                    |
| `provider_events`          | Eventi webhook verificati (consegnato, bounce, …), deduplicati per `(provider_instance_id, external_event_id)` e correlati alla delivery tramite `external_message_id`. |
| `suppressions`             | Destinatari bloccati (hard bounce, complaint, manuale) per tenant e canale.                                                                                             |
| `audit_events`             | Traccia delle operazioni amministrative e dei retry manuali.                                                                                                            |

## Indici principali

| Indice                                       | Uso                                               |
| -------------------------------------------- | ------------------------------------------------- |
| `notifications_tenant_id_created_at_index`   | Lista notifiche per tenant, paginazione keyset    |
| `deliveries_ready_index`                     | Delivery eseguibili per stato e `next_attempt_at` |
| `deliveries_sending_lease_index` (parziale)  | Lease scaduti in `sending` → `unknown`            |
| `outbox_events_available_index` (parziale)   | Eventi da pubblicare                              |
| `outbox_events_published_index` (parziale)   | Pubblicazioni perse da riarmare                   |
| `delivery_attempts_external_reference_index` | Correlazione webhook ↔ tentativo                  |
| `provider_events_message_index`              | Correlazione eventi per `external_message_id`     |
| `provider_events_unprocessed_index`          | Eventi da elaborare                               |
| `audit_events_tenant_id_occurred_at_index`   | Audit per tenant nel tempo                        |

## Reset locale

Il database locale si ricrea da zero eliminando i volumi: `make clean && make up` (applica le migration all'avvio tramite il servizio `migrate`). Valkey va svuotato insieme al database: i job BullMQ usano id `dispatch-<outbox_id>-<n>` che, con id sequenziali ripartiti da 1, colliderebbero con job ancora presenti.
