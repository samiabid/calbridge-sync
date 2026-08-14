export interface CalendarEventOccurrenceIdentity {
  key: string;
  iCalUID: string;
  occurrence: string | null;
}

function normalizeDateLike(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();

  // Keep all-day dates independent of the server timezone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `date:${trimmed}`;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return `raw:${trimmed}`;
  return `time:${parsed.toISOString()}`;
}

export function getCalendarEventOccurrenceIdentity(
  event: any
): CalendarEventOccurrenceIdentity | null {
  const iCalUID = typeof event?.iCalUID === 'string' ? event.iCalUID.trim() : '';
  if (!iCalUID) return null;

  const isRecurringOccurrence = Boolean(event?.recurringEventId || event?.originalStartTime);
  if (!isRecurringOccurrence) {
    return { key: `ical:${iCalUID}`, iCalUID, occurrence: null };
  }

  const occurrence =
    normalizeDateLike(event?.originalStartTime?.dateTime) ||
    normalizeDateLike(event?.originalStartTime?.date) ||
    normalizeDateLike(event?.start?.dateTime) ||
    normalizeDateLike(event?.start?.date);

  if (!occurrence) return null;
  return { key: `ical:${iCalUID}:occurrence:${occurrence}`, iCalUID, occurrence };
}

export function buildNativeOccurrenceIndex(events: any[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event?.status === 'cancelled') continue;
    if (event?.extendedProperties?.private?.syncId) continue;
    const identity = getCalendarEventOccurrenceIdentity(event);
    if (identity) keys.add(identity.key);
  }
  return keys;
}

export function isDuplicateCalendarOccurrence(
  sourceEvent: any,
  destinationOccurrenceKeys: ReadonlySet<string>
): boolean {
  const identity = getCalendarEventOccurrenceIdentity(sourceEvent);
  return Boolean(identity && destinationOccurrenceKeys.has(identity.key));
}
