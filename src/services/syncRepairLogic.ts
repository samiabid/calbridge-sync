export const DEFAULT_REPAIR_DAYS_BACK = 30;
export const DEFAULT_REPAIR_DAYS_FORWARD = 365;
const MAX_REPAIR_DAYS = 730;

export type OrphanReason =
  | 'missing_original_event_id'
  | 'missing_mapping'
  | 'mapping_mismatch'
  | 'missing_source';

export interface RepairWindow {
  daysBack: number;
  daysForward: number;
  timeMin: string;
  timeMax: string;
}

interface OrphanClassificationInput {
  originalEventId: string | null;
  hasMapping: boolean;
  mappingSourceEventId?: string | null;
  sourceExists?: boolean | null;
}

export function normalizeRepairDays(input: unknown, fallback: number): number {
  const parsed =
    typeof input === 'number'
      ? input
      : typeof input === 'string' && input.trim().length > 0
        ? Number.parseInt(input, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(MAX_REPAIR_DAYS, Math.max(0, Math.floor(parsed)));
}

export function buildRepairWindow(
  daysBackInput?: unknown,
  daysForwardInput?: unknown,
  now: Date = new Date()
): RepairWindow {
  const daysBack = normalizeRepairDays(daysBackInput, DEFAULT_REPAIR_DAYS_BACK);
  const daysForward = normalizeRepairDays(daysForwardInput, DEFAULT_REPAIR_DAYS_FORWARD);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - daysBack);
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + daysForward);

  return {
    daysBack,
    daysForward,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

export function getTargetEventSyncId(event: any): string | null {
  const syncId = event?.extendedProperties?.private?.syncId;
  return typeof syncId === 'string' && syncId.trim().length > 0 ? syncId : null;
}

export function getOriginalEventIdFromTargetEvent(event: any): string | null {
  const originalEventId = event?.extendedProperties?.private?.originalEventId;
  return typeof originalEventId === 'string' && originalEventId.trim().length > 0
    ? originalEventId
    : null;
}

export function classifyOrphanCandidate(input: OrphanClassificationInput): OrphanReason | null {
  if (!input.originalEventId) {
    return 'missing_original_event_id';
  }

  if (!input.hasMapping) {
    return 'missing_mapping';
  }

  if (
    input.mappingSourceEventId &&
    input.mappingSourceEventId.trim().length > 0 &&
    input.mappingSourceEventId !== input.originalEventId
  ) {
    return 'mapping_mismatch';
  }

  if (input.sourceExists === false) {
    return 'missing_source';
  }

  return null;
}

export function getOrphanReasonMessage(reason: OrphanReason): string {
  switch (reason) {
    case 'missing_original_event_id':
      return 'Target clone is missing the original source event reference.';
    case 'missing_mapping':
      return 'Target clone exists but the synced-event mapping is missing.';
    case 'mapping_mismatch':
      return 'Target clone original event ID does not match the stored mapping.';
    case 'missing_source':
      return 'Source event no longer exists or is cancelled.';
    default:
      return 'Orphaned target clone detected.';
  }
}
