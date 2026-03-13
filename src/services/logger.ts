type LogLevel = 'info' | 'warn' | 'error';

type LogFieldValue = string | number | boolean | null | undefined;

interface LogFields {
  [key: string]: LogFieldValue;
}

function sanitizeFields(fields?: LogFields) {
  if (!fields) return undefined;

  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function writeLog(level: LogLevel, message: string, fields?: LogFields) {
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(sanitizeFields(fields) || {}),
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(message: string, fields?: LogFields) {
  writeLog('info', message, fields);
}

export function logWarn(message: string, fields?: LogFields) {
  writeLog('warn', message, fields);
}

export function logError(message: string, fields?: LogFields) {
  writeLog('error', message, fields);
}
