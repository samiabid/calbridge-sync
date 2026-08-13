import { getEventMeetingLink } from './syncLogic';

export interface TargetEventCopySettings {
  syncEventTitles: boolean;
  syncEventDescription: boolean;
  syncEventLocation: boolean;
  syncMeetingLinks: boolean;
  markEventPrivate: boolean;
  disableRemindersForClones: boolean;
  eventIdentifier: string | null;
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
  settings: TargetEventCopySettings
) {
  const eventIdentifier = normalizeEventIdentifier(settings);
  const sourceSummary =
    typeof event?.summary === 'string' && event.summary.trim().length > 0
      ? event.summary
      : 'Busy';

  return {
    summary: eventIdentifier || (settings.syncEventTitles ? sourceSummary : 'Busy'),
    description: getTargetEventDescription(event, settings),
    start: event.start,
    end: event.end,
    location: settings.syncEventLocation ? event.location : undefined,
    colorId: event.colorId,
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
        originalEventId: event.id,
      },
    },
  };
}
