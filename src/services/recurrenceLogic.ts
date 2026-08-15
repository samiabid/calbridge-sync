export interface RecurrenceIdentity {
  recurringEventId: string | null;
  originalStart: string | null;
}

export function getOriginalOccurrenceStart(event: any): string | null {
  const value = event?.originalStartTime?.dateTime || event?.originalStartTime?.date;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getRecurrenceIdentity(event: any): RecurrenceIdentity {
  const recurringEventId =
    typeof event?.recurringEventId === 'string' && event.recurringEventId.trim()
      ? event.recurringEventId.trim()
      : null;
  return {
    recurringEventId,
    originalStart: recurringEventId ? getOriginalOccurrenceStart(event) : null,
  };
}

export function isRecurringMaster(event: any): boolean {
  return (
    !event?.recurringEventId &&
    Array.isArray(event?.recurrence) &&
    event.recurrence.some((rule: unknown) => typeof rule === 'string' && rule.length > 0)
  );
}

export function isCancelledOccurrence(event: any): boolean {
  return event?.status === 'cancelled' && Boolean(getRecurrenceIdentity(event).recurringEventId);
}

export function shouldExpandChangedEvent(event: any): boolean {
  return event?.status !== 'cancelled' && isRecurringMaster(event);
}

export function mappingBelongsToSeries(
  mapping: { sourceEventId: string; sourceRecurringEventId?: string | null },
  recurringEventId: string
): boolean {
  if (mapping.sourceRecurringEventId) {
    return mapping.sourceRecurringEventId === recurringEventId;
  }

  // Compatibility for mappings created before recurrence metadata existed.
  return mapping.sourceEventId.startsWith(`${recurringEventId}_`);
}

export function isOriginalStartInWindow(
  value: string | null | undefined,
  timeMin: Date,
  timeMax: Date
): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed >= timeMin && parsed < timeMax;
}

export function getMappingOriginalStart(mapping: {
  sourceEventId: string;
  sourceOriginalStart?: string | null;
}): string | null {
  if (mapping.sourceOriginalStart) return mapping.sourceOriginalStart;
  const match = mapping.sourceEventId.match(/_(\d{8}T\d{6}Z)$/);
  if (!match) return null;
  const value = match[1];
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
    `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
}
