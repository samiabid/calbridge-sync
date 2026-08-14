// Google Calendar event color IDs are the strings 1 through 11.
export const GOOGLE_EVENT_COLOR_IDS = new Set(
  Array.from({ length: 11 }, (_, index) => String(index + 1))
);

export function normalizeGoogleEventColorId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  return GOOGLE_EVENT_COLOR_IDS.has(value) ? value : null;
}
