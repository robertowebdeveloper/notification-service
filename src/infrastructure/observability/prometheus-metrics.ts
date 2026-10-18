import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Channel } from '../../contracts/channels.js';
import type { ErrorCode } from '../../contracts/http-schemas.js';
import {
  API_OPERATIONS,
  PUBLISH_FAILURE_REASONS,
  RECONCILIATION_RESULTS,
  UNKNOWN_SOURCES,
  type ApiOperation,
  type FinalOutcome,
  type Metrics,
  type ProviderCallOutcome,
  type PublishFailureReason,
  type ReconciliationResult,
  type UnknownSource,
  type WebhookInvalidReason,
} from '../../application/ports/metrics.js';

export const METRIC_PREFIX = 'notifications_';

export type ServiceRole = 'api' | 'worker' | 'dispatcher';

/** Provider types are mapped to this label value unless explicitly known (bounded cardinality). */
export const OTHER_LABEL = 'other';

/** Provider call latency: SMTP/HTTP calls are usually sub-second, timeouts reach tens of seconds. */
export const PROVIDER_CALL_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60] as const;

/** Creation -> first attempt: queue latency in normal operation, minutes/hours in a backlog. */
export const TIME_TO_FIRST_ATTEMPT_BUCKETS = [
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 1800, 3600,
] as const;

/** Structural subset of a pino logger used by scrape-time collectors. */
export interface CollectorLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface GaugeSample<L extends string = string> {
  labels?: Partial<Record<L, string>>;
  value: number;
}

export type GaugeSampler<L extends string = string> = () => Promise<readonly GaugeSample<L>[]>;

export interface PrometheusMetricsOptions {
  service: ServiceRole;
  /** Provider types kept as label values; anything else becomes `other`. */
  knownProviderTypes?: readonly string[];
  /** Node.js/process default metrics (default true). */
  defaultMetrics?: boolean;
  logger?: CollectorLogger;
}

const silent: CollectorLogger = { warn: () => undefined, debug: () => undefined };

type GetResult<T extends string> = Awaited<ReturnType<Gauge<T>['get']>>;

/**
 * Gauge evaluated at scrape time. A failing sampler drops the samples of this metric only (the
 * scrape still succeeds); the first failure after a success is logged at warn, repeats at debug.
 */
class PullGauge<T extends string> extends Gauge<T> {
  private failing = false;
  private readonly metricName: string;

  constructor(
    config: { name: string; help: string; labelNames: readonly T[]; registry: Registry },
    private readonly sampler: GaugeSampler<T>,
    private readonly logger: CollectorLogger,
  ) {
    super({
      name: config.name,
      help: config.help,
      labelNames: config.labelNames,
      registers: [config.registry],
    });
    this.metricName = config.name;
  }

  override async get(): Promise<GetResult<T>> {
    const base = await super.get();
    try {
      const samples = await this.sampler();
      if (this.failing)
        this.logger.debug({ metric: this.metricName }, 'metric collector recovered');
      this.failing = false;
      return {
        ...base,
        values: samples
          .filter((s) => Number.isFinite(s.value))
          .map((s) => ({ value: s.value, labels: s.labels ?? {} })),
      };
    } catch (error) {
      const log = { metric: this.metricName, err: errorMessage(error) };
      if (this.failing) this.logger.debug(log, 'metric collector failed');
      else this.logger.warn(log, 'metric collector failed: sample skipped');
      this.failing = true;
      return { ...base, values: [] };
    }
  }
}

/**
 * Shares one sampler call between the gauges fed by it (e.g. one SQL query for two gauges)
 * within a scrape: concurrent calls reuse the in-flight promise, results live for `ttlMs`.
 */
export function shareSample<T>(fn: () => Promise<T>, ttlMs = 1_000): () => Promise<T> {
  let cached: { at: number; promise: Promise<T> } | undefined;
  return () => {
    const now = Date.now();
    if (cached !== undefined && now - cached.at < ttlMs) return cached.promise;
    const promise = fn();
    const entry = { at: now, promise };
    cached = entry;
    promise.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return promise;
  };
}

/** prom-client implementation of the metrics port, with a registry owned by this instance. */
export class PrometheusMetrics implements Metrics {
  readonly registry: Registry;
  private readonly logger: CollectorLogger;
  private readonly knownProviderTypes: ReadonlySet<string>;

  private readonly apiAccepted: Counter<'operation'>;
  private readonly apiRejected: Counter<'operation' | 'reason'>;
  private readonly webhooksReceived: Counter<'provider_type'>;
  private readonly webhooksInvalid: Counter<'provider_type' | 'reason'>;
  private readonly timeToFirstAttempt: Histogram<'channel'>;
  private readonly providerCall: Histogram<'provider_type' | 'outcome'>;
  private readonly retries: Counter<'channel' | 'provider_type'>;
  private readonly fallbacks: Counter<'channel' | 'from_provider_type'>;
  private readonly unknowns: Counter<'source'>;
  private readonly finals: Counter<'channel' | 'outcome'>;
  private readonly published: Counter;
  private readonly publishFailures: Counter<'reason'>;
  private readonly reconciliationResults: Counter<'result'>;

  constructor(options: PrometheusMetricsOptions) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: options.service });
    this.logger = options.logger ?? silent;
    this.knownProviderTypes = new Set(options.knownProviderTypes ?? ['smtp', 'resend']);
    if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });

    const registers = [this.registry];
    const p = METRIC_PREFIX;
    this.apiAccepted = new Counter({
      name: `${p}api_requests_accepted_total`,
      help: 'API requests accepted, by operation.',
      labelNames: ['operation'],
      registers,
    });
    this.apiRejected = new Counter({
      name: `${p}api_requests_rejected_total`,
      help: 'API requests rejected, by operation and error code.',
      labelNames: ['operation', 'reason'],
      registers,
    });
    this.webhooksReceived = new Counter({
      name: `${p}webhooks_received_total`,
      help: 'Authenticated webhook requests stored, by provider type.',
      labelNames: ['provider_type'],
      registers,
    });
    this.webhooksInvalid = new Counter({
      name: `${p}webhooks_invalid_total`,
      help: 'Webhook requests refused, by provider type and reason.',
      labelNames: ['provider_type', 'reason'],
      registers,
    });
    this.timeToFirstAttempt = new Histogram({
      name: `${p}time_to_first_attempt_seconds`,
      help: 'Time from notification creation to the first provider attempt.',
      labelNames: ['channel'],
      buckets: [...TIME_TO_FIRST_ATTEMPT_BUCKETS],
      registers,
    });
    this.providerCall = new Histogram({
      name: `${p}provider_call_duration_seconds`,
      help: 'Duration of provider send calls, by provider type and outcome.',
      labelNames: ['provider_type', 'outcome'],
      buckets: [...PROVIDER_CALL_BUCKETS],
      registers,
    });
    this.retries = new Counter({
      name: `${p}retries_scheduled_total`,
      help: 'Retries scheduled after a provider rejection.',
      labelNames: ['channel', 'provider_type'],
      registers,
    });
    this.fallbacks = new Counter({
      name: `${p}fallbacks_total`,
      help: 'Fallbacks to the next provider of the routing snapshot.',
      labelNames: ['channel', 'from_provider_type'],
      registers,
    });
    this.unknowns = new Counter({
      name: `${p}unknown_transitions_total`,
      help: 'Deliveries moved to unknown, by source.',
      labelNames: ['source'],
      registers,
    });
    this.finals = new Counter({
      name: `${p}final_outcomes_total`,
      help: 'Deliveries that reached a terminal state.',
      labelNames: ['channel', 'outcome'],
      registers,
    });
    this.published = new Counter({
      name: `${p}outbox_published_total`,
      help: 'Outbox events confirmed by the queue.',
      registers,
    });
    this.publishFailures = new Counter({
      name: `${p}outbox_publish_failures_total`,
      help: 'Outbox events left re-publishable after a failed publication, by reason.',
      labelNames: ['reason'],
      registers,
    });
    this.reconciliationResults = new Counter({
      name: `${p}reconciliation_results_total`,
      help: 'Reconciliation results, by kind.',
      labelNames: ['result'],
      registers,
    });

    // Zero-initialised series for closed label sets, so rate() works from the first scrape.
    for (const operation of API_OPERATIONS) this.apiAccepted.inc({ operation }, 0);
    for (const reason of PUBLISH_FAILURE_REASONS) this.publishFailures.inc({ reason }, 0);
    for (const result of RECONCILIATION_RESULTS) this.reconciliationResults.inc({ result }, 0);
    for (const source of UNKNOWN_SOURCES) this.unknowns.inc({ source }, 0);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** Prometheus text exposition of every metric of this process. */
  scrape(): Promise<string> {
    return this.registry.metrics();
  }

  /** Registers a gauge evaluated at scrape time; failures skip its samples only. */
  registerPullGauge<L extends string>(
    name: string,
    help: string,
    labelNames: readonly L[],
    sampler: GaugeSampler<L>,
  ): void {
    new PullGauge({ name, help, labelNames, registry: this.registry }, sampler, this.logger);
  }

  apiRequestAccepted(operation: ApiOperation): void {
    this.apiAccepted.inc({ operation });
  }

  apiRequestRejected(operation: ApiOperation, reason: ErrorCode): void {
    this.apiRejected.inc({ operation, reason });
  }

  webhookReceived(providerType: string): void {
    this.webhooksReceived.inc({ provider_type: this.providerLabel(providerType) });
  }

  webhookInvalid(providerType: string, reason: WebhookInvalidReason): void {
    this.webhooksInvalid.inc({ provider_type: this.providerLabel(providerType), reason });
  }

  observeTimeToFirstAttempt(channel: Channel, seconds: number): void {
    if (validDuration(seconds)) this.timeToFirstAttempt.observe({ channel }, seconds);
  }

  observeProviderCall(providerType: string, outcome: ProviderCallOutcome, seconds: number): void {
    if (!validDuration(seconds)) return;
    this.providerCall.observe(
      { provider_type: this.providerLabel(providerType), outcome },
      seconds,
    );
  }

  retryScheduled(channel: Channel, providerType: string): void {
    this.retries.inc({ channel, provider_type: this.providerLabel(providerType) });
  }

  fallbackTaken(channel: Channel, fromProviderType: string): void {
    this.fallbacks.inc({ channel, from_provider_type: this.providerLabel(fromProviderType) });
  }

  unknownTransition(source: UnknownSource, count = 1): void {
    if (validCount(count)) this.unknowns.inc({ source }, count);
  }

  finalOutcome(channel: Channel, outcome: FinalOutcome): void {
    this.finals.inc({ channel, outcome });
  }

  outboxPublished(count: number): void {
    if (validCount(count)) this.published.inc(count);
  }

  outboxPublishFailed(reason: PublishFailureReason, count: number): void {
    if (validCount(count)) this.publishFailures.inc({ reason }, count);
  }

  reconciliation(result: ReconciliationResult, count: number): void {
    if (validCount(count)) this.reconciliationResults.inc({ result }, count);
  }

  private providerLabel(providerType: string): string {
    return this.knownProviderTypes.has(providerType) ? providerType : OTHER_LABEL;
  }
}

function validCount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
