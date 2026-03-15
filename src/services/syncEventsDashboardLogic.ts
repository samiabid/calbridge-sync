import type { SyncDirection } from './syncAudit';
import type { EventSkipReason } from './syncLogic';
import {
  DEFAULT_REPAIR_DAYS_BACK,
  DEFAULT_REPAIR_DAYS_FORWARD,
  buildRepairWindow,
  type RepairWindow,
} from './syncRepairLogic';

export type SyncEventStatus = 'failed' | 'synced' | 'skipped' | 'not_synced';
export type SyncEventDirectionFilter = 'all' | SyncDirection;

export const DEFAULT_EVENTS_PAGE = 1;
export const DEFAULT_EVENTS_PAGE_SIZE = 25;
export const MAX_EVENTS_PAGE_SIZE = 100;

export interface SyncEventFailureOverlay {
  id?: string;
  errorMessage?: string | null;
  lastFailedAt?: Date | string | null;
}

export interface SyncEventMappingOverlay {
  targetEventId: string;
  targetCalendarId?: string | null;
  lastSyncedAt?: Date | string | null;
}

export interface SyncEventStatusResult {
  status: SyncEventStatus;
  statusReason: string;
}

function normalizePositiveInteger(input: unknown, fallback: number): number {
  const parsed =
    typeof input === 'number'
      ? input
      : typeof input === 'string' && input.trim().length > 0
        ? Number.parseInt(input, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.floor(parsed));
}

export function normalizeEventsPage(input: unknown): number {
  return normalizePositiveInteger(input, DEFAULT_EVENTS_PAGE);
}

export function normalizeEventsPageSize(input: unknown): number {
  return Math.min(MAX_EVENTS_PAGE_SIZE, normalizePositiveInteger(input, DEFAULT_EVENTS_PAGE_SIZE));
}

export function normalizeSyncEventDirection(
  input: unknown,
  isTwoWay: boolean
): SyncEventDirectionFilter {
  if (input === 'source_to_target') {
    return 'source_to_target';
  }

  if (input === 'target_to_source' && isTwoWay) {
    return 'target_to_source';
  }

  return isTwoWay ? 'all' : 'source_to_target';
}

export function normalizeForceSyncDirection(input: unknown, isTwoWay: boolean): SyncDirection {
  if (input === 'source_to_target') {
    return 'source_to_target';
  }

  if (input === 'target_to_source' && isTwoWay) {
    return 'target_to_source';
  }

  throw new Error('Invalid sync direction');
}

export function getRequestedDirections(
  direction: SyncEventDirectionFilter,
  isTwoWay: boolean
): SyncDirection[] {
  if (direction === 'all') {
    return isTwoWay ? ['source_to_target', 'target_to_source'] : ['source_to_target'];
  }

  return [direction];
}

export function buildSyncEventsWindow(
  daysBackInput?: unknown,
  daysForwardInput?: unknown,
  now: Date = new Date()
): RepairWindow {
  return buildRepairWindow(daysBackInput, daysForwardInput, now);
}

export function getSyncEventSortTime(event: any): number {
  const rawStart = event?.start?.dateTime || event?.start?.date || event?.created || null;
  const parsed = rawStart ? new Date(rawStart).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function paginateSyncEventRows<T>(
  rows: T[],
  pageInput: unknown,
  pageSizeInput: unknown
): {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: T[];
} {
  const pageSize = normalizeEventsPageSize(pageSizeInput);
  const total = rows.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const requestedPage = normalizeEventsPage(pageInput);
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;

  return {
    page,
    pageSize,
    total,
    totalPages,
    items: rows.slice(start, start + pageSize),
  };
}

function formatLastSyncedAt(lastSyncedAt: Date | string | null | undefined): string | null {
  if (!lastSyncedAt) return null;
  const parsed = new Date(lastSyncedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function formatLastFailedAt(lastFailedAt: Date | string | null | undefined): string | null {
  if (!lastFailedAt) return null;
  const parsed = new Date(lastFailedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function computeSyncEventStatus(input: {
  failure?: SyncEventFailureOverlay | null;
  mapping?: SyncEventMappingOverlay | null;
  skipReason?: EventSkipReason | null;
}): SyncEventStatusResult {
  if (input.failure) {
    const lastFailedAt = formatLastFailedAt(input.failure.lastFailedAt);
    return {
      status: 'failed',
      statusReason: input.failure.errorMessage
        ? lastFailedAt
          ? `${input.failure.errorMessage} Last failed at ${lastFailedAt}.`
          : input.failure.errorMessage
        : 'Event has an open sync failure.',
    };
  }

  if (input.mapping) {
    const lastSyncedAt = formatLastSyncedAt(input.mapping.lastSyncedAt);
    return {
      status: 'synced',
      statusReason: lastSyncedAt
        ? `Synced to ${input.mapping.targetEventId} at ${lastSyncedAt}.`
        : `Synced to ${input.mapping.targetEventId}.`,
    };
  }

  if (input.skipReason) {
    return {
      status: 'skipped',
      statusReason: input.skipReason.message,
    };
  }

  return {
    status: 'not_synced',
    statusReason: 'Eligible event has not been synced yet.',
  };
}

export const syncEventsDashboardDefaults = {
  daysBack: DEFAULT_REPAIR_DAYS_BACK,
  daysForward: DEFAULT_REPAIR_DAYS_FORWARD,
  page: DEFAULT_EVENTS_PAGE,
  pageSize: DEFAULT_EVENTS_PAGE_SIZE,
};
