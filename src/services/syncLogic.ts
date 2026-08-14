export const ALLOWED_RSVP_STATUSES = [
  'accepted',
  'tentative',
  'needsAction',
  'declined',
] as const;

export type RsvpStatus = (typeof ALLOWED_RSVP_STATUSES)[number];

export interface ReadableSourceSettings {
  syncEventTitles: boolean;
  syncEventDescription: boolean;
  syncEventLocation: boolean;
  syncMeetingLinks: boolean;
}

export interface EventSkipReason {
  code:
    | 'excluded_color'
    | 'excluded_keyword'
    | 'loop_prevention'
    | 'free_event'
    | 'rsvp'
    | 'no_readable_details'
    | 'duplicate_ical_uid';
  message: string;
}

export interface CancellationState {
  cancelledEventIds: Set<string>;
  bulkCancelledSeriesIds: Set<string>;
}

export function normalizeRsvpStatuses(input: unknown): RsvpStatus[] {
  if (!Array.isArray(input)) return [...ALLOWED_RSVP_STATUSES];

  const valid = input
    .filter((status): status is RsvpStatus =>
      typeof status === 'string' &&
      (ALLOWED_RSVP_STATUSES as readonly string[]).includes(status)
    );

  if (valid.length === 0) {
    return [...ALLOWED_RSVP_STATUSES];
  }

  return [...new Set(valid)];
}

export function getEventSelfResponseStatus(event: any): RsvpStatus {
  const selfAttendee = Array.isArray(event?.attendees)
    ? event.attendees.find((attendee: any) => attendee?.self)
    : null;
  const status = selfAttendee?.responseStatus;

  return (ALLOWED_RSVP_STATUSES as readonly string[]).includes(status)
    ? (status as RsvpStatus)
    : 'accepted';
}

export function getEventMeetingLink(event: any): string | null {
  if (typeof event?.hangoutLink === 'string' && event.hangoutLink.trim().length > 0) {
    return event.hangoutLink.trim();
  }

  const entryPoint = Array.isArray(event?.conferenceData?.entryPoints)
    ? event.conferenceData.entryPoints.find(
        (entry: any) => typeof entry?.uri === 'string' && entry.uri.trim().length > 0
      )
    : null;

  return entryPoint?.uri?.trim() || null;
}

export function needsReadableSourceDetails(settings: ReadableSourceSettings): boolean {
  return (
    settings.syncEventTitles ||
    settings.syncEventDescription ||
    settings.syncEventLocation ||
    settings.syncMeetingLinks
  );
}

export function isDetailPlaceholderSummary(summary: string | null | undefined): boolean {
  if (!summary || typeof summary !== 'string') return false;
  const normalized = summary.trim().toLowerCase();
  return (
    normalized === 'busy' ||
    normalized === 'no title' ||
    normalized === '(no title)' ||
    normalized === 'untitled' ||
    normalized === '(untitled)'
  );
}

export function eventHasAnyCopyableDetails(event: any): boolean {
  if (
    typeof event?.summary === 'string' &&
    event.summary.trim().length > 0 &&
    !isDetailPlaceholderSummary(event.summary)
  ) {
    return true;
  }
  if (typeof event?.description === 'string' && event.description.trim().length > 0) return true;
  if (typeof event?.location === 'string' && event.location.trim().length > 0) return true;
  if (getEventMeetingLink(event)) return true;
  return false;
}

export function getReadableDetailsSkipReason(
  event: any,
  settings: ReadableSourceSettings
): EventSkipReason | null {
  if (!needsReadableSourceDetails(settings)) {
    return null;
  }

  if (eventHasAnyCopyableDetails(event)) {
    return null;
  }

  return {
    code: 'no_readable_details',
    message: 'Source event has no readable title, description, location, or meeting link.',
  };
}

export function getFilterSkipReason(
  event: any,
  excludedColors: string[],
  excludedKeywords: string[],
  syncFreeEvents: boolean,
  copyRsvpStatuses: string[]
): EventSkipReason | null {
  if (event.colorId && excludedColors.includes(event.colorId)) {
    return {
      code: 'excluded_color',
      message: `Event color ${event.colorId} is excluded by sync settings.`,
    };
  }

  const text = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  for (const keyword of excludedKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      return {
        code: 'excluded_keyword',
        message: `Event matches excluded keyword "${keyword}".`,
      };
    }
  }

  if (event.extendedProperties?.private?.syncId) {
    return {
      code: 'loop_prevention',
      message: 'Event was created by this sync and is ignored to prevent loops.',
    };
  }

  if (!syncFreeEvents && event.transparency === 'transparent') {
    return {
      code: 'free_event',
      message: 'Free or transparent events are excluded by sync settings.',
    };
  }

  const allowedStatuses = normalizeRsvpStatuses(copyRsvpStatuses);
  const responseStatus = getEventSelfResponseStatus(event);
  if (!allowedStatuses.includes(responseStatus)) {
    return {
      code: 'rsvp',
      message: `Event RSVP status "${responseStatus}" is excluded by sync settings.`,
    };
  }

  return null;
}

export function shouldSkipEvent(
  event: any,
  excludedColors: string[],
  excludedKeywords: string[],
  syncFreeEvents: boolean,
  copyRsvpStatuses: string[]
): boolean {
  return Boolean(
    getFilterSkipReason(
      event,
      excludedColors,
      excludedKeywords,
      syncFreeEvents,
      copyRsvpStatuses
    )
  );
}

export function getRecurringSeriesIdFromEventId(eventId: unknown): string | undefined {
  if (typeof eventId !== 'string') return undefined;
  const index = eventId.indexOf('_');
  if (index <= 0) return undefined;

  return eventId.slice(0, index);
}

export function getRecurringSeriesId(event: any): string | undefined {
  if (event?.recurringEventId && typeof event.recurringEventId === 'string') {
    return event.recurringEventId;
  }

  return getRecurringSeriesIdFromEventId(event?.id);
}

export function buildCancellationState(events: any[]): CancellationState {
  const cancelledEventIds = new Set<string>();
  const cancelledSeriesCounts = new Map<string, number>();

  for (const event of events) {
    if (event?.status !== 'cancelled' || !event?.id) continue;
    cancelledEventIds.add(event.id);
    const recurringSeriesId = getRecurringSeriesId(event);
    if (!recurringSeriesId) continue;
    cancelledSeriesCounts.set(
      recurringSeriesId,
      (cancelledSeriesCounts.get(recurringSeriesId) || 0) + 1
    );
  }

  const bulkCancelledSeriesIds = new Set(
    Array.from(cancelledSeriesCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([seriesId]) => seriesId)
  );

  return {
    cancelledEventIds,
    bulkCancelledSeriesIds,
  };
}

export function shouldSkipActiveEventDueToCancellation(
  event: any,
  state: CancellationState
): boolean {
  if (!event?.id) return false;
  if (state.cancelledEventIds.has(event.id)) {
    return true;
  }

  const recurringSeriesId = getRecurringSeriesId(event);
  return Boolean(recurringSeriesId && state.bulkCancelledSeriesIds.has(recurringSeriesId));
}

// The next webhook fetch must start no later than this run's fetch start:
// events updated after fetch start may sit on already-fetched pages, so
// advancing the watermark to the max event `updated` timestamp can skip them.
// Using the earlier of the two keeps the extra overlap when Google's
// `updated` values lag behind wall-clock time.
export function computeNextWebhookWatermark(
  fetchStartedAt: Date,
  lastDetectedChangeAt: Date | null,
  overlapMs: number
): Date {
  const base =
    lastDetectedChangeAt && lastDetectedChangeAt.getTime() < fetchStartedAt.getTime()
      ? lastDetectedChangeAt
      : fetchStartedAt;
  return new Date(Math.max(0, base.getTime() - overlapMs));
}

// Account detection is capped per burst, but re-opens after a cooldown so a
// sync doesn't stay stuck once calendar access is restored.
export function shouldAttemptAccountDetection(
  attempts: number,
  lastAttemptAt: Date | null,
  now: Date,
  options: { maxAttempts?: number; cooldownMs?: number } = {}
): { attempt: boolean; isCooldownRetry: boolean } {
  const maxAttempts = options.maxAttempts ?? 3;
  const cooldownMs = options.cooldownMs ?? 6 * 60 * 60 * 1000;

  if (attempts < maxAttempts) {
    return { attempt: true, isCooldownRetry: false };
  }

  if (!lastAttemptAt || now.getTime() - lastAttemptAt.getTime() >= cooldownMs) {
    return { attempt: true, isCooldownRetry: true };
  }

  return { attempt: false, isCooldownRetry: false };
}

// Older syncs may only have the legacy `googleAccountId`; every consumer
// should resolve per-side account ids through this single fallback chain.
export function resolveSyncAccounts(sync: {
  googleAccountId: string;
  sourceGoogleAccountId?: string | null;
  targetGoogleAccountId?: string | null;
}): { sourceAccountId: string; targetAccountId: string } {
  return {
    sourceAccountId: sync.sourceGoogleAccountId || sync.googleAccountId,
    targetAccountId: sync.targetGoogleAccountId || sync.googleAccountId,
  };
}
