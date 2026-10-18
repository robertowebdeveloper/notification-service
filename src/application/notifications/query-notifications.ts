import type { ListNotificationsQuery, NotificationView } from '../../contracts/http-schemas.js';
import { InvalidCursorError } from '../ports/lookup-repositories.js';
import type {
  NotificationDetail,
  NotificationRepository,
  NotificationSummary,
} from '../ports/repositories.js';
import { ApplicationError } from './errors.js';

export type NotificationSummaryView = Omit<NotificationView, 'attempts' | 'lastError'>;

export function toSummaryView(summary: NotificationSummary): NotificationSummaryView {
  return {
    id: summary.id,
    channel: summary.channel,
    platform: summary.platform,
    routingKey: summary.routingKey,
    submissionStatus: summary.submissionStatus,
    receiptStatus: summary.receiptStatus,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  };
}

export function toNotificationView(detail: NotificationDetail): NotificationView {
  return {
    ...toSummaryView(detail),
    attempts: detail.attempts.map((attempt) => ({
      number: attempt.number,
      outcome: attempt.outcome,
      startedAt: attempt.startedAt.toISOString(),
      finishedAt: attempt.finishedAt?.toISOString() ?? null,
      errorCode: attempt.errorCode,
    })),
    lastError: detail.lastError,
  };
}

export const DEFAULT_PAGE_SIZE = 25;

export class QueryNotifications {
  constructor(private readonly notifications: Pick<NotificationRepository, 'findById' | 'list'>) {}

  async get(tenantId: string, id: string): Promise<NotificationView> {
    const detail = await this.notifications.findById(tenantId, id);
    if (detail === null) throw new ApplicationError('not_found', 'Notification not found');
    return toNotificationView(detail);
  }

  async list(
    tenantId: string,
    query: ListNotificationsQuery,
  ): Promise<{ items: NotificationSummaryView[]; nextCursor: string | null }> {
    if (
      query.createdFrom !== undefined &&
      query.createdTo !== undefined &&
      Date.parse(query.createdFrom) > Date.parse(query.createdTo)
    ) {
      throw new ApplicationError('validation_error', 'createdFrom must not be after createdTo');
    }
    try {
      const page = await this.notifications.list(tenantId, {
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.channel === undefined ? {} : { channel: query.channel }),
        ...(query.createdFrom === undefined ? {} : { createdFrom: new Date(query.createdFrom) }),
        ...(query.createdTo === undefined ? {} : { createdTo: new Date(query.createdTo) }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return { items: page.items.map(toSummaryView), nextCursor: page.nextCursor };
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new ApplicationError('validation_error', 'Invalid pagination cursor');
      }
      throw error;
    }
  }
}
