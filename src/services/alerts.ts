import { logError, logInfo, logWarn } from './logger';

type AlertSeverity = 'info' | 'warn' | 'error';

interface AlertPayload {
  severity: AlertSeverity;
  key: string;
  message: string;
  details?: Record<string, string | number | boolean | null | undefined>;
  cooldownMs?: number;
}

const alertCooldowns = new Map<string, number>();
const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

function getCooldownMs(override?: number) {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override;
  }

  const envValue = Number.parseInt(process.env.ALERT_COOLDOWN_MS || '', 10);
  if (Number.isFinite(envValue) && envValue >= 0) {
    return envValue;
  }

  return DEFAULT_ALERT_COOLDOWN_MS;
}

function shouldSendAlert(key: string, cooldownMs: number) {
  const now = Date.now();
  const nextAllowedAt = alertCooldowns.get(key) || 0;
  if (nextAllowedAt > now) {
    return false;
  }

  alertCooldowns.set(key, now + cooldownMs);
  return true;
}

export async function sendAlert(payload: AlertPayload) {
  const cooldownMs = getCooldownMs(payload.cooldownMs);
  if (!shouldSendAlert(payload.key, cooldownMs)) {
    return;
  }

  const event = {
    alertKey: payload.key,
    message: payload.message,
    cooldownMs,
    ...(payload.details || {}),
  };

  if (payload.severity === 'error') {
    logError('alert_triggered', event);
  } else if (payload.severity === 'warn') {
    logWarn('alert_triggered', event);
  } else {
    logInfo('alert_triggered', event);
  }

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        severity: payload.severity,
        key: payload.key,
        message: payload.message,
        details: payload.details || {},
        timestamp: new Date().toISOString(),
        service: 'calendar-sync-app',
      }),
    });

    if (!response.ok) {
      logWarn('alert_webhook_failed', {
        alertKey: payload.key,
        status: response.status,
      });
    }
  } catch (error: any) {
    logWarn('alert_webhook_failed', {
      alertKey: payload.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
