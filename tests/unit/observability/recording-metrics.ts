import type { Metrics } from '../../../src/application/ports/metrics.js';

export type MetricCall = [method: keyof Metrics, ...args: unknown[]];

/** Fake Metrics port recording every call as `[method, ...args]`. */
export class RecordingMetrics implements Metrics {
  readonly calls: MetricCall[] = [];

  /** Calls of one method, without the method name. */
  of(method: keyof Metrics): unknown[][] {
    return this.calls.filter(([name]) => name === method).map(([, ...args]) => args);
  }

  apiRequestAccepted(...args: unknown[]): void {
    this.calls.push(['apiRequestAccepted', ...args]);
  }
  apiRequestRejected(...args: unknown[]): void {
    this.calls.push(['apiRequestRejected', ...args]);
  }
  webhookReceived(...args: unknown[]): void {
    this.calls.push(['webhookReceived', ...args]);
  }
  webhookInvalid(...args: unknown[]): void {
    this.calls.push(['webhookInvalid', ...args]);
  }
  observeTimeToFirstAttempt(...args: unknown[]): void {
    this.calls.push(['observeTimeToFirstAttempt', ...args]);
  }
  observeProviderCall(...args: unknown[]): void {
    this.calls.push(['observeProviderCall', ...args]);
  }
  retryScheduled(...args: unknown[]): void {
    this.calls.push(['retryScheduled', ...args]);
  }
  fallbackTaken(...args: unknown[]): void {
    this.calls.push(['fallbackTaken', ...args]);
  }
  unknownTransition(...args: unknown[]): void {
    this.calls.push(['unknownTransition', ...args]);
  }
  finalOutcome(...args: unknown[]): void {
    this.calls.push(['finalOutcome', ...args]);
  }
  outboxPublished(...args: unknown[]): void {
    this.calls.push(['outboxPublished', ...args]);
  }
  outboxPublishFailed(...args: unknown[]): void {
    this.calls.push(['outboxPublishFailed', ...args]);
  }
  reconciliation(...args: unknown[]): void {
    this.calls.push(['reconciliation', ...args]);
  }
}
