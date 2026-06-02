import { PrismaClient } from '@prisma/client';
import { getAuthenticatedCalendar } from './calendar';

const prisma = new PrismaClient();

interface DiagnosticsDeps {
  prisma?: any;
  getCalendar?: typeof getAuthenticatedCalendar;
  now?: () => Date;
}

export interface ProductionDiagnosticsResult {
  generatedAt: string;
  duplicateMappings: Array<{
    syncId: string;
    sourceCalendarId: string;
    sourceEventId: string;
    count: number;
    targetEventIds: string[];
  }>;
  webhookIssues: Array<{
    syncId: string;
    direction: 'source' | 'target';
    calendarId: string;
    issue: 'missing_channel' | 'missing_resource' | 'missing_expiration' | 'expired';
    expiration: string | null;
  }>;
  openFailures: {
    count: number;
    recent: Array<{
      id: string;
      syncId: string;
      direction: string;
      action: string;
      sourceEventId: string | null;
      targetEventId: string | null;
      errorCode: string | null;
      errorMessage: string;
      lastFailedAt: string;
    }>;
  };
  accountIssues: Array<{
    accountId: string;
    email: string;
    status: 'connected' | 'disconnected';
    reason: string | null;
  }>;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pushWebhookIssues(
  issues: ProductionDiagnosticsResult['webhookIssues'],
  sync: any,
  direction: 'source' | 'target',
  now: Date
) {
  const calendarId = direction === 'source' ? sync.sourceCalendarId : sync.targetCalendarId;
  const channelId = direction === 'source' ? sync.sourceChannelId : sync.targetChannelId;
  const resourceId = direction === 'source' ? sync.sourceResourceId : sync.targetResourceId;
  const expiration = direction === 'source' ? sync.sourceExpiration : sync.targetExpiration;
  const expirationIso = toIso(expiration);

  if (!channelId) {
    issues.push({ syncId: sync.id, direction, calendarId, issue: 'missing_channel', expiration: expirationIso });
  }
  if (!resourceId) {
    issues.push({ syncId: sync.id, direction, calendarId, issue: 'missing_resource', expiration: expirationIso });
  }
  if (!expiration) {
    issues.push({ syncId: sync.id, direction, calendarId, issue: 'missing_expiration', expiration: null });
  } else if (new Date(expiration) < now) {
    issues.push({ syncId: sync.id, direction, calendarId, issue: 'expired', expiration: expirationIso });
  }
}

export function buildProductionDiagnosticsService(deps: DiagnosticsDeps = {}) {
  const prismaClient = deps.prisma || prisma;
  const getCalendar = deps.getCalendar || getAuthenticatedCalendar;
  const getNow = deps.now || (() => new Date());

  async function getDuplicateMappings(userId: string): Promise<ProductionDiagnosticsResult['duplicateMappings']> {
    const mappings = await prismaClient.syncedEvent.findMany({
      where: { sync: { userId } },
      select: {
        syncId: true,
        sourceCalendarId: true,
        sourceEventId: true,
        targetEventId: true,
      },
      orderBy: [{ syncId: 'asc' }, { sourceCalendarId: 'asc' }, { sourceEventId: 'asc' }],
    });

    const grouped = new Map<string, {
      syncId: string;
      sourceCalendarId: string;
      sourceEventId: string;
      targetEventIds: Set<string>;
      count: number;
    }>();

    for (const mapping of mappings) {
      const key = `${mapping.syncId}:${mapping.sourceCalendarId}:${mapping.sourceEventId}`;
      const existing = grouped.get(key) || {
        syncId: mapping.syncId,
        sourceCalendarId: mapping.sourceCalendarId,
        sourceEventId: mapping.sourceEventId,
        targetEventIds: new Set<string>(),
        count: 0,
      };
      existing.count += 1;
      existing.targetEventIds.add(mapping.targetEventId);
      grouped.set(key, existing);
    }

    return Array.from(grouped.values())
      .filter((item) => item.count > 1)
      .map((item) => ({
        syncId: item.syncId,
        sourceCalendarId: item.sourceCalendarId,
        sourceEventId: item.sourceEventId,
        count: item.count,
        targetEventIds: Array.from(item.targetEventIds),
      }));
  }

  async function getWebhookIssues(userId: string, now: Date): Promise<ProductionDiagnosticsResult['webhookIssues']> {
    const syncs = await prismaClient.sync.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        isTwoWay: true,
        sourceCalendarId: true,
        targetCalendarId: true,
        sourceChannelId: true,
        sourceResourceId: true,
        sourceExpiration: true,
        targetChannelId: true,
        targetResourceId: true,
        targetExpiration: true,
      },
    });

    const issues: ProductionDiagnosticsResult['webhookIssues'] = [];
    for (const sync of syncs) {
      pushWebhookIssues(issues, sync, 'source', now);
      if (sync.isTwoWay) {
        pushWebhookIssues(issues, sync, 'target', now);
      }
    }
    return issues;
  }

  async function getOpenFailures(userId: string): Promise<ProductionDiagnosticsResult['openFailures']> {
    const [count, recent] = await Promise.all([
      prismaClient.syncFailure.count({ where: { userId, status: 'open' } }),
      prismaClient.syncFailure.findMany({
        where: { userId, status: 'open' },
        orderBy: [{ lastFailedAt: 'desc' }],
        take: 20,
        select: {
          id: true,
          syncId: true,
          direction: true,
          action: true,
          sourceEventId: true,
          targetEventId: true,
          errorCode: true,
          errorMessage: true,
          lastFailedAt: true,
        },
      }),
    ]);

    return {
      count,
      recent: recent.map((failure: any) => ({
        ...failure,
        lastFailedAt: toIso(failure.lastFailedAt) || '',
      })),
    };
  }

  async function getAccountIssues(userId: string): Promise<ProductionDiagnosticsResult['accountIssues']> {
    const accounts = await prismaClient.googleAccount.findMany({
      where: { userId },
      select: { id: true, displayName: true },
      orderBy: [{ displayName: 'asc' }],
    });

    return Promise.all(
      accounts.map(async (account: any) => {
        try {
          const calendar = await getCalendar(userId, account.id);
          await calendar.calendarList.list({ maxResults: 1 });
          return {
            accountId: account.id,
            email: account.displayName,
            status: 'connected' as const,
            reason: null,
          };
        } catch (error) {
          return {
            accountId: account.id,
            email: account.displayName,
            status: 'disconnected' as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );
  }

  async function getProductionDiagnostics(userId: string): Promise<ProductionDiagnosticsResult> {
    const now = getNow();
    const [duplicateMappings, webhookIssues, openFailures, accountIssues] = await Promise.all([
      getDuplicateMappings(userId),
      getWebhookIssues(userId, now),
      getOpenFailures(userId),
      getAccountIssues(userId),
    ]);

    return {
      generatedAt: now.toISOString(),
      duplicateMappings,
      webhookIssues,
      openFailures,
      accountIssues,
    };
  }

  return { getProductionDiagnostics };
}

export const { getProductionDiagnostics } = buildProductionDiagnosticsService();
