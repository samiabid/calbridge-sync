import { getAuthenticatedCalendar } from './calendar';
import { withRateLimitRetry } from './rateLimit';
import { syncEvent, type SyncEventOutcome } from './sync';
import {
  recordSyncAudit,
  resolveOpenFailuresForSourceEvent,
  type SyncDirection,
} from './syncAudit';
import {
  getFilterSkipReason,
  getReadableDetailsSkipReason,
} from './syncLogic';
import {
  buildSyncEventsWindow,
  computeSyncEventStatus,
  getRequestedDirections,
  getSyncEventSortTime,
  eventMatchesSearch,
  normalizeEventSearch,
  normalizeForceSyncDirection,
  normalizeSyncEventDirection,
  paginateSyncEventRows,
  type SyncEventDirectionFilter,
  type SyncEventFailureOverlay,
  type SyncEventMappingOverlay,
  type SyncEventStatus,
} from './syncEventsDashboardLogic';
import { prisma } from './prisma';


interface DirectionContext {
  direction: SyncDirection;
  sourceCalendarId: string;
  targetCalendarId: string;
  sourceGoogleAccountId: string;
  targetGoogleAccountId: string;
}

interface EventDashboardSyncRecord {
  id: string;
  userId: string;
  googleAccountId: string;
  sourceGoogleAccountId: string | null;
  targetGoogleAccountId: string | null;
  sourceCalendarId: string;
  sourceCalendarName: string;
  targetCalendarId: string;
  targetCalendarName: string;
  isTwoWay: boolean;
  isActive: boolean;
  excludedColors: string[];
  excludedKeywords: string[];
  syncEventTitles: boolean;
  syncEventDescription: boolean;
  syncEventLocation: boolean;
  syncMeetingLinks: boolean;
  syncFreeEvents: boolean;
  copyRsvpStatuses: string[];
}

interface DashboardSourceEventRow {
  direction: SyncDirection;
  sourceCalendarId: string;
  targetCalendarId: string;
  sourceGoogleAccountId: string;
  targetGoogleAccountId: string;
  event: any;
}

export interface SyncDashboardEventItem {
  direction: SyncDirection;
  sourceEventId: string;
  sourceCalendarId: string;
  targetCalendarId: string;
  sourceGoogleAccountId: string;
  targetGoogleAccountId: string;
  summary: string;
  location: string | null;
  start: any;
  end: any;
  isAllDay: boolean;
  sourceStatus: string | null;
  status: SyncEventStatus;
  statusReason: string;
  targetEventId: string | null;
  lastSyncedAt: string | null;
  failureId: string | null;
}

export interface ListSyncDashboardEventsResult {
  syncId: string;
  syncLabel: string;
  isTwoWay: boolean;
  direction: SyncEventDirectionFilter;
  window: ReturnType<typeof buildSyncEventsWindow>;
  page: number;
  pageSize: number;
  search: string;
  total: number;
  totalPages: number;
  items: SyncDashboardEventItem[];
}

export interface ForceSyncDashboardEventInput {
  direction: unknown;
  sourceEventId: string;
  sourceCalendarId?: string;
}

export interface ForceSyncDashboardEventResult {
  syncId: string;
  item: SyncDashboardEventItem;
}

interface SyncEventsDashboardServiceDeps {
  prisma?: any;
  getCalendar?: typeof getAuthenticatedCalendar;
  rateLimitRetry?: typeof withRateLimitRetry;
  runSyncEvent?: (...args: Parameters<typeof syncEvent>) => Promise<SyncEventOutcome | void>;
  recordAudit?: typeof recordSyncAudit;
  resolveFailuresForSourceEvent?: typeof resolveOpenFailuresForSourceEvent;
}

function getDirectionContext(sync: EventDashboardSyncRecord, direction: SyncDirection): DirectionContext {
  const sourceGoogleAccountId = sync.sourceGoogleAccountId || sync.googleAccountId;
  const targetGoogleAccountId = sync.targetGoogleAccountId || sync.googleAccountId;

  if (direction === 'source_to_target') {
    return {
      direction,
      sourceCalendarId: sync.sourceCalendarId,
      targetCalendarId: sync.targetCalendarId,
      sourceGoogleAccountId,
      targetGoogleAccountId,
    };
  }

  return {
    direction,
    sourceCalendarId: sync.targetCalendarId,
    targetCalendarId: sync.sourceCalendarId,
    sourceGoogleAccountId: targetGoogleAccountId,
    targetGoogleAccountId: sourceGoogleAccountId,
  };
}

function buildDirectionContexts(
  sync: EventDashboardSyncRecord,
  direction: SyncEventDirectionFilter
): DirectionContext[] {
  return getRequestedDirections(direction, sync.isTwoWay).map((item) => getDirectionContext(sync, item));
}

function getDisplaySummary(event: any): string {
  if (typeof event?.summary === 'string' && event.summary.trim().length > 0) {
    return event.summary.trim();
  }

  return '(No title)';
}

function createEventKey(direction: SyncDirection, sourceCalendarId: string, sourceEventId: string): string {
  return `${direction}:${sourceCalendarId}:${sourceEventId}`;
}

async function listEventsInWindow(
  calendar: any,
  calendarId: string,
  window: ReturnType<typeof buildSyncEventsWindow>,
  rateLimitRetry: typeof withRateLimitRetry,
  context: string
) {
  const events: any[] = [];
  let pageToken: string | undefined;

  do {
    const response: any = await rateLimitRetry(
      () =>
        calendar.events.list({
          calendarId,
          timeMin: window.timeMin,
          timeMax: window.timeMax,
          showDeleted: false,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500,
          pageToken,
        }),
      context
    );

    if (Array.isArray(response.data?.items)) {
      events.push(...response.data.items);
    }

    pageToken = response.data?.nextPageToken || undefined;
  } while (pageToken);

  return events.filter((event) => Boolean(event?.id));
}

function getSkipReason(sync: EventDashboardSyncRecord, event: any, targetCalendarId: string) {
  const readableReason = getReadableDetailsSkipReason(event, {
    syncEventTitles: sync.syncEventTitles,
    syncEventDescription: sync.syncEventDescription,
    syncEventLocation: sync.syncEventLocation,
    syncMeetingLinks: sync.syncMeetingLinks,
  });

  if (readableReason) {
    return readableReason;
  }

  return getFilterSkipReason(
    event,
    sync.excludedColors,
    sync.excludedKeywords,
    sync.syncFreeEvents,
    sync.copyRsvpStatuses,
    { syncId: sync.id, targetCalendarId }
  );
}

async function buildDashboardEventItem(
  sync: EventDashboardSyncRecord,
  row: DashboardSourceEventRow,
  failureMap: Map<string, SyncEventFailureOverlay>,
  mappingMap: Map<string, SyncEventMappingOverlay>,
  duplicateMap: Map<string, string>
): Promise<SyncDashboardEventItem> {
  const event = row.event;
  const key = createEventKey(row.direction, row.sourceCalendarId, event.id);
  const failure = failureMap.get(key) || null;
  const mapping = mappingMap.get(key) || null;
  const duplicateReason = duplicateMap.get(key);
  const status = computeSyncEventStatus({
    failure,
    mapping,
    skipReason: duplicateReason
      ? { code: 'duplicate_ical_uid', message: duplicateReason }
      : getSkipReason(sync, event, row.targetCalendarId),
  });

  return {
    direction: row.direction,
    sourceEventId: event.id,
    sourceCalendarId: row.sourceCalendarId,
    targetCalendarId: row.targetCalendarId,
    sourceGoogleAccountId: row.sourceGoogleAccountId,
    targetGoogleAccountId: row.targetGoogleAccountId,
    summary: getDisplaySummary(event),
    location: typeof event?.location === 'string' && event.location.trim().length > 0 ? event.location : null,
    start: event.start || null,
    end: event.end || null,
    isAllDay: Boolean(event?.start?.date && !event?.start?.dateTime),
    sourceStatus: typeof event?.status === 'string' ? event.status : null,
    status: status.status,
    statusReason: status.statusReason,
    targetEventId: mapping?.targetEventId || null,
    lastSyncedAt:
      mapping?.lastSyncedAt && !Number.isNaN(new Date(mapping.lastSyncedAt).getTime())
        ? new Date(mapping.lastSyncedAt).toISOString()
        : null,
    failureId: failure?.id || null,
  };
}

export function buildSyncEventsDashboardService(deps: SyncEventsDashboardServiceDeps = {}) {
  const prismaClient = deps.prisma || prisma;
  const getCalendar = deps.getCalendar || getAuthenticatedCalendar;
  const rateLimitRetry = deps.rateLimitRetry || withRateLimitRetry;
  const runSyncEvent = deps.runSyncEvent || syncEvent;
  const recordAudit = deps.recordAudit || recordSyncAudit;
  const resolveFailuresForSourceEvent =
    deps.resolveFailuresForSourceEvent || resolveOpenFailuresForSourceEvent;

  async function getSyncOrThrow(
    syncId: string,
    userId: string,
    options: { requireActive?: boolean } = {}
  ): Promise<EventDashboardSyncRecord> {
    const sync = await prismaClient.sync.findFirst({
      where: {
        id: syncId,
        userId,
      },
      select: {
        id: true,
        userId: true,
        googleAccountId: true,
        sourceGoogleAccountId: true,
        targetGoogleAccountId: true,
        sourceCalendarId: true,
        sourceCalendarName: true,
        targetCalendarId: true,
        targetCalendarName: true,
        isTwoWay: true,
        isActive: true,
        excludedColors: true,
        excludedKeywords: true,
        syncEventTitles: true,
        syncEventDescription: true,
        syncEventLocation: true,
        syncMeetingLinks: true,
        syncFreeEvents: true,
        copyRsvpStatuses: true,
      },
    });

    if (!sync) {
      throw new Error('Sync not found');
    }

    if (options.requireActive && !sync.isActive) {
      throw new Error('Sync is paused. Resume it before forcing sync.');
    }

    return sync;
  }

  async function getOverlayMaps(
    syncId: string,
    userId: string,
    rows: DashboardSourceEventRow[]
  ): Promise<{
    failureMap: Map<string, SyncEventFailureOverlay>;
    mappingMap: Map<string, SyncEventMappingOverlay>;
    duplicateMap: Map<string, string>;
  }> {
    const eventIds = Array.from(new Set(rows.map((row) => row.event.id).filter(Boolean)));
    const sourceCalendarIds = Array.from(new Set(rows.map((row) => row.sourceCalendarId)));
    const directions = Array.from(new Set(rows.map((row) => row.direction)));

    if (eventIds.length === 0) {
      return {
        failureMap: new Map(),
        mappingMap: new Map(),
        duplicateMap: new Map(),
      };
    }

    const [failures, mappings, duplicateAudits] = await Promise.all([
      prismaClient.syncFailure.findMany({
        where: {
          syncId,
          userId,
          status: 'open',
          direction: { in: directions },
          sourceEventId: { in: eventIds },
          sourceCalendarId: { in: sourceCalendarIds },
        },
        orderBy: [{ lastFailedAt: 'desc' }],
      }),
      prismaClient.syncedEvent.findMany({
        where: {
          syncId,
          sourceEventId: { in: eventIds },
          sourceCalendarId: { in: sourceCalendarIds },
        },
        orderBy: [{ lastSyncedAt: 'desc' }],
      }),
      prismaClient.syncEventAudit?.findMany
        ? prismaClient.syncEventAudit.findMany({
            where: {
              syncId,
              userId,
              direction: { in: directions },
              sourceEventId: { in: eventIds },
              sourceCalendarId: { in: sourceCalendarIds },
              reasonCode: 'duplicate_ical_uid',
              result: 'skipped',
            },
            orderBy: [{ createdAt: 'desc' }],
          })
        : Promise.resolve([]),
    ]);

    const failureMap = new Map<string, SyncEventFailureOverlay>();
    for (const failure of failures) {
      if (!failure.sourceEventId || !failure.sourceCalendarId) continue;
      const key = createEventKey(
        failure.direction as SyncDirection,
        failure.sourceCalendarId,
        failure.sourceEventId
      );
      if (!failureMap.has(key)) {
        failureMap.set(key, {
          id: failure.id,
          errorMessage: failure.errorMessage,
          lastFailedAt: failure.lastFailedAt,
        });
      }
    }

    const mappingMap = new Map<string, SyncEventMappingOverlay>();
    for (const mapping of mappings) {
      const matchingDirection = rows.find(
        (row) =>
          row.sourceCalendarId === mapping.sourceCalendarId && row.event.id === mapping.sourceEventId
      )?.direction;
      if (!matchingDirection) continue;
      const key = createEventKey(matchingDirection, mapping.sourceCalendarId, mapping.sourceEventId);
      if (!mappingMap.has(key)) {
        mappingMap.set(key, {
          targetEventId: mapping.targetEventId,
          targetCalendarId: mapping.targetCalendarId,
          lastSyncedAt: mapping.lastSyncedAt,
        });
      }
    }

    const duplicateMap = new Map<string, string>();
    for (const audit of duplicateAudits) {
      if (!audit.sourceEventId || !audit.sourceCalendarId) continue;
      const key = createEventKey(
        audit.direction as SyncDirection,
        audit.sourceCalendarId,
        audit.sourceEventId
      );
      if (!duplicateMap.has(key)) {
        duplicateMap.set(
          key,
          audit.reasonMessage ||
            'The same native Google invite already exists on the destination calendar.'
        );
      }
    }

    return {
      failureMap,
      mappingMap,
      duplicateMap,
    };
  }

  async function listSyncDashboardEvents(
    syncId: string,
    userId: string,
    options: {
      daysBack?: unknown;
      daysForward?: unknown;
      direction?: unknown;
      page?: unknown;
      pageSize?: unknown;
      search?: unknown;
    } = {}
  ): Promise<ListSyncDashboardEventsResult> {
    const sync = await getSyncOrThrow(syncId, userId);
    const direction = normalizeSyncEventDirection(options.direction, sync.isTwoWay);
    const window = buildSyncEventsWindow(options.daysBack, options.daysForward);
    const search = normalizeEventSearch(options.search);
    const contexts = buildDirectionContexts(sync, direction);

    const rows: DashboardSourceEventRow[] = (
      await Promise.all(
        contexts.map(async (context) => {
          const calendar = await getCalendar(userId, context.sourceGoogleAccountId);
          const events = await listEventsInWindow(
            calendar,
            context.sourceCalendarId,
            window,
            rateLimitRetry,
            `listing dashboard events for sync ${syncId} (${context.direction})`
          );

          return events.map((event) => ({
            direction: context.direction,
            sourceCalendarId: context.sourceCalendarId,
            targetCalendarId: context.targetCalendarId,
            sourceGoogleAccountId: context.sourceGoogleAccountId,
            targetGoogleAccountId: context.targetGoogleAccountId,
            event,
          }));
        })
      )
    ).flat();

    rows.sort((left, right) => {
      const byTime = getSyncEventSortTime(left.event) - getSyncEventSortTime(right.event);
      if (byTime !== 0) return byTime;
      return String(left.event.id).localeCompare(String(right.event.id));
    });

    const filteredRows = rows.filter((row) => eventMatchesSearch(row.event, search));

    const { failureMap, mappingMap, duplicateMap } = await getOverlayMaps(
      sync.id,
      userId,
      filteredRows
    );
    const items = await Promise.all(
      filteredRows.map((row) =>
        buildDashboardEventItem(sync, row, failureMap, mappingMap, duplicateMap)
      )
    );
    const paginated = paginateSyncEventRows(items, options.page, options.pageSize);

    return {
      syncId: sync.id,
      syncLabel: `${sync.sourceCalendarName} -> ${sync.targetCalendarName}`,
      isTwoWay: sync.isTwoWay,
      direction,
      window,
      search,
      page: paginated.page,
      pageSize: paginated.pageSize,
      total: paginated.total,
      totalPages: paginated.totalPages,
      items: paginated.items,
    };
  }

  async function forceSyncDashboardEvent(
    syncId: string,
    userId: string,
    input: ForceSyncDashboardEventInput
  ): Promise<ForceSyncDashboardEventResult> {
    const sync = await getSyncOrThrow(syncId, userId, { requireActive: true });
    const direction = normalizeForceSyncDirection(input.direction, sync.isTwoWay);
    const context = getDirectionContext(sync, direction);
    const sourceCalendarId = input.sourceCalendarId || context.sourceCalendarId;

    if (!input.sourceEventId || typeof input.sourceEventId !== 'string') {
      throw new Error('Source event ID is required');
    }

    if (sourceCalendarId !== context.sourceCalendarId) {
      throw new Error('Source calendar does not match the selected sync direction');
    }

    const sourceCalendar = await getCalendar(userId, context.sourceGoogleAccountId);
    const response: any = await rateLimitRetry(
      () =>
        sourceCalendar.events.get({
          calendarId: sourceCalendarId,
          eventId: input.sourceEventId,
        }),
      `loading dashboard source event ${input.sourceEventId}`
    );

    if (!response.data?.id) {
      throw new Error('Source event could not be loaded');
    }

    try {
      const outcome = await runSyncEvent(
        sync.id,
        userId,
        response.data,
        sourceCalendarId,
        context.targetCalendarId,
        context.targetGoogleAccountId,
        false,
        context.sourceGoogleAccountId,
        direction
      );

      const skipReason =
        outcome?.status === 'duplicate'
          ? {
              code: outcome.reasonCode || 'duplicate_ical_uid',
              message:
                outcome.reasonMessage ||
                'The same native Google invite already exists on the destination calendar.',
            }
          : getSkipReason(sync, response.data, context.targetCalendarId);
      await resolveFailuresForSourceEvent(
        sync.id,
        userId,
        direction,
        input.sourceEventId,
        skipReason
          ? 'Resolved after manual force sync produced a skipped result'
          : 'Resolved after manual force sync'
      );

      await recordAudit({
        syncId: sync.id,
        userId,
        direction,
        action: 'force_resync',
        result: 'success',
        sourceEventId: input.sourceEventId,
        sourceCalendarId,
        eventSummary: response.data.summary || null,
        reasonMessage: skipReason
          ? `Manual force sync completed with skipped status: ${skipReason.message}`
          : 'Manual force sync completed successfully',
      });
    } catch (error: any) {
      await recordAudit({
        syncId: sync.id,
        userId,
        direction,
        action: 'force_resync',
        result: 'failure',
        sourceEventId: input.sourceEventId,
        sourceCalendarId,
        eventSummary: response.data?.summary || null,
        reasonCode: String(error?.code || error?.response?.status || ''),
        reasonMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const { failureMap, mappingMap, duplicateMap } = await getOverlayMaps(sync.id, userId, [
      {
        direction,
        sourceCalendarId,
        targetCalendarId: context.targetCalendarId,
        sourceGoogleAccountId: context.sourceGoogleAccountId,
        targetGoogleAccountId: context.targetGoogleAccountId,
        event: response.data,
      },
    ]);

    const item = await buildDashboardEventItem(
      sync,
      {
        direction,
        sourceCalendarId,
        targetCalendarId: context.targetCalendarId,
        sourceGoogleAccountId: context.sourceGoogleAccountId,
        targetGoogleAccountId: context.targetGoogleAccountId,
        event: response.data,
      },
      failureMap,
      mappingMap,
      duplicateMap
    );

    return {
      syncId: sync.id,
      item,
    };
  }

  return {
    listSyncDashboardEvents,
    forceSyncDashboardEvent,
  };
}

export const { listSyncDashboardEvents, forceSyncDashboardEvent } =
  buildSyncEventsDashboardService();
