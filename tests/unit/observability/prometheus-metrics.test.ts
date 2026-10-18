import { describe, expect, it, vi } from 'vitest';
import { NoopMetrics, type Metrics } from '../../../src/application/ports/metrics.js';
import {
  PROVIDER_CALL_BUCKETS,
  PrometheusMetrics,
  shareSample,
} from '../../../src/infrastructure/observability/prometheus-metrics.js';

function metrics(service: 'api' | 'worker' | 'dispatcher' = 'worker') {
  return new PrometheusMetrics({ service, defaultMetrics: false });
}

function lines(text: string, name: string): string[] {
  return text.split('\n').filter((l) => l.startsWith(name));
}

describe('PrometheusMetrics', () => {
  it('keeps a private registry per instance, so instances never share samples', async () => {
    const a = metrics();
    const b = metrics();
    a.outboxPublished(3);

    expect(lines(await a.scrape(), 'notifications_outbox_published_total')).toEqual([
      'notifications_outbox_published_total{service="worker"} 3',
    ]);
    expect(lines(await b.scrape(), 'notifications_outbox_published_total')).toEqual([
      'notifications_outbox_published_total{service="worker"} 0',
    ]);
  });

  it('adds the service default label and node process metrics when enabled', async () => {
    const m = new PrometheusMetrics({ service: 'dispatcher' });
    const text = await m.scrape();
    expect(text).toMatch(/^process_cpu_user_seconds_total\{service="dispatcher"\} /m);
    expect(text).toMatch(/^nodejs_heap_size_used_bytes\{service="dispatcher"\} /m);
  });

  it('records every port method with low-cardinality labels only', async () => {
    const m = metrics();
    const port: Metrics = m;
    port.apiRequestAccepted('create_notification');
    port.apiRequestRejected('create_notification', 'idempotency_conflict');
    port.webhookReceived('resend');
    port.webhookInvalid('resend', 'invalid_signature');
    port.observeTimeToFirstAttempt('email', 1.2);
    port.observeProviderCall('smtp', 'accepted', 0.3);
    port.retryScheduled('email', 'smtp');
    port.fallbackTaken('email', 'resend');
    port.unknownTransition('stale_lease', 2);
    port.finalOutcome('email', 'accepted');
    port.outboxPublishFailed('queue_unavailable', 2);
    port.reconciliation('rearmed', 4);

    const text = await m.scrape();
    const expected = [
      'notifications_api_requests_accepted_total{operation="create_notification",service="worker"} 1',
      'notifications_api_requests_rejected_total{operation="create_notification",reason="idempotency_conflict",service="worker"} 1',
      'notifications_webhooks_received_total{provider_type="resend",service="worker"} 1',
      'notifications_webhooks_invalid_total{provider_type="resend",reason="invalid_signature",service="worker"} 1',
      'notifications_time_to_first_attempt_seconds_count{service="worker",channel="email"} 1',
      'notifications_provider_call_duration_seconds_count{service="worker",provider_type="smtp",outcome="accepted"} 1',
      'notifications_retries_scheduled_total{channel="email",provider_type="smtp",service="worker"} 1',
      'notifications_fallbacks_total{channel="email",from_provider_type="resend",service="worker"} 1',
      'notifications_unknown_transitions_total{source="stale_lease",service="worker"} 2',
      'notifications_final_outcomes_total{channel="email",outcome="accepted",service="worker"} 1',
      'notifications_outbox_publish_failures_total{reason="queue_unavailable",service="worker"} 2',
      'notifications_reconciliation_results_total{result="rearmed",service="worker"} 4',
    ];
    for (const line of expected) expect(text).toContain(line);
  });

  it('maps unregistered provider types to "other" to bound cardinality', async () => {
    const m = metrics();
    m.webhookInvalid('attacker-controlled-123', 'malformed');
    m.observeProviderCall('custom', 'unknown', 1);

    const text = await m.scrape();
    expect(text).toContain(
      'notifications_webhooks_invalid_total{provider_type="other",reason="malformed",service="worker"} 1',
    );
    expect(text).not.toContain('attacker-controlled-123');
    expect(text).toContain('provider_type="other",outcome="unknown"');
  });

  it('keeps known provider types configurable', async () => {
    const m = new PrometheusMetrics({
      service: 'worker',
      defaultMetrics: false,
      knownProviderTypes: ['twilio'],
    });
    m.retryScheduled('sms', 'twilio');
    m.retryScheduled('sms', 'smtp');
    const text = await m.scrape();
    expect(text).toContain('channel="sms",provider_type="twilio"');
    expect(text).toContain('channel="sms",provider_type="other"');
  });

  it('uses provider latency buckets from 50 ms to 60 s', async () => {
    const m = metrics();
    m.observeProviderCall('smtp', 'rejected', 0.07);
    const buckets = lines(await m.scrape(), 'notifications_provider_call_duration_seconds_bucket');
    const les = buckets.map((l) => /le="([^"]+)"/.exec(l)?.[1]);
    expect(les).toEqual([...PROVIDER_CALL_BUCKETS.map(String), '+Inf']);
    expect(buckets.find((l) => l.includes('le="0.05"'))).toMatch(/ 0$/);
    expect(buckets.find((l) => l.includes('le="0.1"'))).toMatch(/ 1$/);
  });

  it('ignores invalid counts and durations instead of throwing', async () => {
    const m = metrics();
    expect(() => {
      m.outboxPublished(-1);
      m.outboxPublished(Number.NaN);
      m.reconciliation('step_failed', 0);
      m.observeProviderCall('smtp', 'accepted', -2);
      m.observeTimeToFirstAttempt('email', Number.POSITIVE_INFINITY);
    }).not.toThrow();
    const text = await m.scrape();
    expect(text).toContain('notifications_outbox_published_total{service="worker"} 0');
    expect(text).not.toContain('notifications_provider_call_duration_seconds_count');
  });

  it('zero-initialises closed label sets', async () => {
    const text = await metrics().scrape();
    expect(text).toContain(
      'notifications_api_requests_accepted_total{operation="retry_notification",service="worker"} 0',
    );
    expect(text).toContain(
      'notifications_reconciliation_results_total{result="step_failed",service="worker"} 0',
    );
  });

  it('evaluates pull gauges at scrape time', async () => {
    const m = metrics();
    let value = 1;
    m.registerPullGauge('notifications_test_value', 'test', ['kind'], () =>
      Promise.resolve([{ labels: { kind: 'a' }, value }]),
    );
    expect(await m.scrape()).toContain('notifications_test_value{kind="a",service="worker"} 1');
    value = 7;
    expect(await m.scrape()).toContain('notifications_test_value{kind="a",service="worker"} 7');
  });

  it('skips the samples of a failing collector without failing the scrape', async () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const m = new PrometheusMetrics({
      service: 'worker',
      defaultMetrics: false,
      logger: { warn, debug },
    });
    m.registerPullGauge('notifications_broken', 'broken', [], () =>
      Promise.reject(new Error('connection refused')),
    );
    m.registerPullGauge('notifications_ok', 'ok', [], () => Promise.resolve([{ value: 5 }]));

    const first = await m.scrape();
    expect(first).toContain('notifications_ok{service="worker"} 5');
    expect(first).toContain('# TYPE notifications_broken gauge');
    expect(lines(first, 'notifications_broken')).toEqual([]);
    await m.scrape();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { metric: 'notifications_broken', err: 'connection refused' },
      expect.any(String),
    );
    expect(debug).toHaveBeenCalledTimes(1);
  });
});

describe('shareSample', () => {
  it('reuses one call within the ttl and retries after a failure', async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('x')) : Promise.resolve(calls);
    });
    const shared = shareSample(fn, 60_000);
    await expect(shared()).rejects.toThrow('x');
    expect(await Promise.all([shared(), shared()])).toEqual([2, 2]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('NoopMetrics', () => {
  it('accepts every call without side effects', () => {
    const m: Metrics = new NoopMetrics();
    expect(() => {
      m.apiRequestAccepted('retry_notification');
      m.observeProviderCall('smtp', 'accepted', 1);
      m.reconciliation('rearmed', 1);
    }).not.toThrow();
  });
});
