import { getEventMeetingLink, getEventSyncLineage } from './syncLogic';
import { normalizeGoogleEventColorId } from './eventColors';

export interface TargetEventCopySettings {
  syncEventTitles: boolean;
  syncEventDescription: boolean;
  syncEventLocation: boolean;
  syncMeetingLinks: boolean;
  markEventPrivate: boolean;
  disableRemindersForClones: boolean;
  eventIdentifier: string | null;
  cloneColorId: string | null;
}

export interface TargetEventLineageContext {
  sourceCalendarId: string;
  targetCalendarId: string;
}

export function normalizeEventIdentifier(
  settings: TargetEventCopySettings
): string | null {
  if (!settings.eventIdentifier) return null;
  const value = settings.eventIdentifier.trim();
  return value.length > 0 ? value : null;
}

function getTargetEventDescription(
  event: any,
  settings: TargetEventCopySettings
): string | undefined {
  const parts: string[] = [];

  if (
    settings.syncEventDescription &&
    typeof event?.description === 'string' &&
    event.description.trim()
  ) {
    parts.push(event.description.trim());
  }

  if (settings.syncMeetingLinks) {
    const meetingLink = getEventMeetingLink(event);
    if (meetingLink) {
      const currentText = parts.join('\n\n');
      if (!currentText.includes(meetingLink)) {
        parts.push(`Meeting Link: ${meetingLink}`);
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export function buildTargetEventRequestBody(
  syncId: string,
  event: any,
  settings: TargetEventCopySettings,
  lineageContext?: TargetEventLineageContext
) {
  const eventIdentifier = normalizeEventIdentifier(settings);
  const sourceSummary =
    typeof event?.summary === 'string' && event.summary.trim().length > 0
      ? event.summary
      : 'Busy';
  const existingLineage = getEventSyncLineage(event);
  const syncLineage = [...new Set([...existingLineage.syncIds, syncId])];
  const calendarLineage = lineageContext
    ? [
        ...new Set([
          ...existingLineage.calendarIds,
          lineageContext.sourceCalendarId,
          lineageContext.targetCalendarId,
        ]),
      ]
    : existingLineage.calendarIds;
  const sourceMetadata = event?.extendedProperties?.private || {};

  return {
    summary: settings.syncEventTitles
      ? eventIdentifier
        ? `${sourceSummary} ${eventIdentifier}`
        : sourceSummary
      : eventIdentifier || 'Busy',
    description: getTargetEventDescription(event, settings),
    start: event.start,
    end: event.end,
    location: settings.syncEventLocation ? event.location : undefined,
    colorId: normalizeGoogleEventColorId(settings.cloneColorId) || event.colorId,
    visibility: settings.markEventPrivate ? 'private' : event.visibility,
    reminders: settings.disableRemindersForClones
      ? {
          useDefault: false,
          overrides: [],
        }
      : event.reminders,
    extendedProperties: {
      private: {
        syncId,
        originalEventId: sourceMetadata.originalEventId || event.id,
        syncLineage: JSON.stringify(syncLineage),
        ...(calendarLineage.length > 0
          ? { calendarLineage: JSON.stringify(calendarLineage) }
          : {}),
      },
    },
  };
}
