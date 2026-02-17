const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

function parseRetryAfterHeader(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const asSeconds = Number(value);
  if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return null;

  return Math.max(0, retryAt - Date.now());
}

function getRateLimitReason(error: any): string | null {
  const details = error?.response?.data?.error;
  const reasonsFromArray = Array.isArray(details?.errors)
    ? details.errors
        .map((entry: any) => (typeof entry?.reason === 'string' ? entry.reason : ''))
        .filter(Boolean)
    : [];
  const fallbackReason =
    typeof details?.status === 'string'
      ? details.status
      : typeof details?.message === 'string'
        ? details.message
        : '';
  const reason = [reasonsFromArray.join(','), fallbackReason].filter(Boolean).join(',');
  return reason || null;
}

export function isRateLimitError(error: any): boolean {
  const status = error?.response?.status || error?.status || error?.code;
  const message = String(error?.message || '').toLowerCase();
  const reason = (getRateLimitReason(error) || '').toLowerCase();

  if (status === 429) return true;
  if (status === 403) {
    if (
      reason.includes('ratelimit') ||
      reason.includes('quotaexceeded') ||
      reason.includes('userratelimitexceeded') ||
      reason.includes('rate_limit_exceeded') ||
      reason.includes('resource_exhausted')
    ) {
      return true;
    }
  }

  return (
    message.includes('quota exceeded') ||
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('resource_exhausted')
  );
}

function getRetryDelayMs(error: any, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const retryAfterMs =
    parseRetryAfterHeader(error?.response?.headers?.['retry-after']) ??
    parseRetryAfterHeader(error?.response?.headers?.['Retry-After']);

  if (retryAfterMs !== null) {
    return Math.min(maxDelayMs, Math.max(baseDelayMs, retryAfterMs));
  }

  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(maxDelayMs, exponential + jitter);
}

export async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  context: string,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }

      const delayMs = getRetryDelayMs(error, attempt, baseDelayMs, maxDelayMs);
      const reason = getRateLimitReason(error);
      console.warn(
        `Rate-limited during ${context}. retry=${attempt + 1}/${maxRetries} delayMs=${delayMs}${
          reason ? ` reason=${reason}` : ''
        }`
      );
      await sleepMs(delayMs);
      attempt += 1;
    }
  }
}

