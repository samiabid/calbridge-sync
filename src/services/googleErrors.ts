export function getGoogleErrorStatus(error: any): number | undefined {
  const status = error?.code || error?.status || error?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

export function isGoogleCalendarEventGoneError(error: any): boolean {
  const status = getGoogleErrorStatus(error);
  return status === 404 || status === 410;
}
