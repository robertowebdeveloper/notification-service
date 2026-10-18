import { ENABLED_CHANNELS, type Channel, type ChannelPayload } from '../../contracts/channels.js';
import { parseMailbox } from '../../contracts/email-address.js';
import { LIMITS, type CreateNotificationBody } from '../../contracts/http-schemas.js';
import type { ProviderConfigRepository } from '../ports/lookup-repositories.js';
import type { NotificationRepository, RoutingSnapshot } from '../ports/repositories.js';
import { requestHash } from './canonical.js';
import { ApplicationError } from './errors.js';
import type { BacklogGuard, IngressLimiter } from './ingress-guards.js';
import type { Clock, SenderPolicyRepository } from './ports.js';
import { isSenderAllowed } from './sender-policy.js';

/** Structural subset of the provider registry: routing reasons on capabilities only. */
export interface CapabilityChecker {
  supports(
    providerType: string,
    requirements: { channel: Channel; platform?: string; format?: string },
  ): boolean;
}

export interface CreateNotificationDeps {
  notifications: Pick<NotificationRepository, 'create' | 'findByIdempotencyKey'>;
  providerConfig: Pick<ProviderConfigRepository, 'resolveRoutingPolicy'>;
  capabilities: CapabilityChecker;
  senderPolicy: SenderPolicyRepository;
  ingress: IngressLimiter;
  backlog: BacklogGuard;
  clock: Clock;
}

export interface CreateNotificationCommand {
  tenantId: number;
  idempotencyKey: string;
  body: CreateNotificationBody;
}

export interface CreateNotificationOutcome {
  notificationId: number;
  replayed: boolean;
}

function platformOf(payload: ChannelPayload): string | null {
  switch (payload.channel) {
    case 'push':
    case 'messaging':
      return payload.recipient.platform;
    default:
      return null;
  }
}

/** Content formats the selected provider must support. */
function formatsOf(payload: ChannelPayload): string[] {
  switch (payload.channel) {
    case 'email':
      return [
        ...(payload.content.text !== undefined ? ['text'] : []),
        ...(payload.content.html !== undefined ? ['html'] : []),
      ];
    case 'sms':
      return ['text'];
    case 'push':
      return [];
    case 'messaging':
      return [payload.content.type];
  }
}

function toPayload(body: CreateNotificationBody): ChannelPayload {
  // The body schema is the contract for every channel payload (metadata/routingKey excluded).
  return {
    channel: body.channel,
    recipient: body.recipient,
    content: body.content,
  } as ChannelPayload;
}

/** Checks not expressible in JSON Schema (400 / 403). */
export function validateBusinessRules(body: CreateNotificationBody): void {
  if (
    body.channel === 'email' &&
    body.content.text === undefined &&
    body.content.html === undefined
  ) {
    throw new ApplicationError(
      'validation_error',
      'Either content.text or content.html is required',
      [{ instancePath: '/content', message: 'must have text or html' }],
    );
  }
  if (body.channel === 'email' && parseMailbox(body.content.from) === null) {
    throw new ApplicationError('validation_error', 'content.from must be exactly one mailbox', [
      { instancePath: '/content/from', message: 'must be exactly one mailbox' },
    ]);
  }
  const metadataBytes = Buffer.byteLength(JSON.stringify(body.metadata ?? {}), 'utf8');
  if (metadataBytes > LIMITS.metadataBytes) {
    throw new ApplicationError(
      'validation_error',
      `metadata exceeds ${LIMITS.metadataBytes} bytes once serialized`,
      [{ instancePath: '/metadata', message: `must be at most ${LIMITS.metadataBytes} bytes` }],
    );
  }
}

export class CreateNotification {
  constructor(private readonly deps: CreateNotificationDeps) {}

  async execute(command: CreateNotificationCommand): Promise<CreateNotificationOutcome> {
    const { body, tenantId } = command;
    if (!ENABLED_CHANNELS.has(body.channel)) {
      throw new ApplicationError(
        'channel_not_enabled',
        `Channel "${body.channel}" is not enabled in this release`,
      );
    }
    validateBusinessRules(body);
    await this.deps.ingress.check(tenantId);

    const metadata = body.metadata ?? {};
    const hash = requestHash({
      routingKey: body.routingKey,
      channel: body.channel,
      recipient: body.recipient,
      content: body.content,
      metadata,
    });
    // A replay answers with the original outcome even if sender rules, routing policy or backlog
    // changed since the first request: it creates nothing. Concurrent first requests still race
    // to the insert below, whose unique constraint keeps exactly one notification.
    const existing = await this.deps.notifications.findByIdempotencyKey(
      tenantId,
      command.idempotencyKey,
    );
    if (existing !== null) {
      if (existing.requestHash !== hash) throw idempotencyConflict();
      return { notificationId: existing.notificationId, replayed: true };
    }

    await this.deps.backlog.assertAccepting();

    if (body.channel === 'email') {
      const allowed = await this.deps.senderPolicy.allowedSenders(tenantId);
      if (!isSenderAllowed(body.content.from, allowed)) {
        throw new ApplicationError('forbidden', 'Sender is not allowed for this tenant');
      }
    }

    const payload = toPayload(body);
    const platform = platformOf(payload);
    const policy = await this.deps.providerConfig.resolveRoutingPolicy(
      tenantId,
      body.routingKey,
      body.channel,
      platform,
    );
    if (policy === null || !policy.enabled) {
      throw new ApplicationError('no_compatible_route', 'No routing policy for this routingKey');
    }
    const formats = formatsOf(payload);
    const candidates = policy.providers.filter(
      (instance) =>
        instance.enabled &&
        instance.channel === body.channel &&
        formats.every((format) =>
          this.deps.capabilities.supports(instance.providerType, {
            channel: body.channel,
            ...(platform === null ? {} : { platform }),
            format,
          }),
        ) &&
        this.deps.capabilities.supports(instance.providerType, {
          channel: body.channel,
          ...(platform === null ? {} : { platform }),
        }),
    );
    const first = candidates[0];
    if (first === undefined) {
      throw new ApplicationError('no_compatible_route', 'No compatible provider is available');
    }

    const routing: RoutingSnapshot = {
      policyId: policy.id,
      policyVersion: policy.version,
      platform,
      // Without fallback only the highest-priority compatible instance may be used.
      providerInstanceIds: policy.fallbackEnabled ? candidates.map((c) => c.id) : [first.id],
      maxAttempts: policy.maxAttempts,
      fallbackEnabled: policy.fallbackEnabled,
    };
    const now = this.deps.clock();
    const result = await this.deps.notifications.create({
      tenantId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hash,
      routingKey: body.routingKey,
      payload,
      metadata,
      routing,
      expiresAt: new Date(now.getTime() + policy.ttlSeconds * 1000),
    });

    switch (result.kind) {
      case 'created':
        return { notificationId: result.notificationId, replayed: false };
      case 'replayed':
        return { notificationId: result.notificationId, replayed: true };
      case 'conflict':
        throw idempotencyConflict();
    }
  }
}

function idempotencyConflict(): ApplicationError {
  return new ApplicationError(
    'idempotency_conflict',
    'Idempotency-Key was already used with a different request',
  );
}
