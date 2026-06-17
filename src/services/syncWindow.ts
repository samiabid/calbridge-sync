export const DEFAULT_SYNC_FUTURE_DAYS = 365;
const MIN_SYNC_FUTURE_DAYS = 1;
const MAX_SYNC_FUTURE_DAYS = 730;

export function normalizeSyncFutureDays(input: unknown): number {
  const parsed =
    typeof input === 'number'
      ? input
      : typeof input === 'string' && input.trim().length > 0
        ? Number.parseInt(input, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return DEFAULT_SYNC_FUTURE_DAYS;
  }

  return Math.min(MAX_SYNC_FUTURE_DAYS, Math.max(MIN_SYNC_FUTURE_DAYS, Math.floor(parsed)));
}

export function getSyncFutureWindowEnd(now: Date = new Date(), daysInput: unknown = process.env.SYNC_FUTURE_DAYS): Date {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + normalizeSyncFutureDays(daysInput));
  return end;
}
