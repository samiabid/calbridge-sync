import { logInfo } from './logger';

const DEFAULT_MIN_INTERVAL_MS = 125;

function getMinIntervalMs(): number {
  const parsed = Number.parseInt(process.env.GOOGLE_API_MIN_INTERVAL_MS || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIN_INTERVAL_MS;
  return Math.min(parsed, 10_000);
}

class GoogleApiGovernor {
  private tail: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  async waitForTurn(): Promise<void> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const now = Date.now();
      const delayMs = Math.max(0, this.nextStartAt - now);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      this.nextStartAt = Date.now() + getMinIntervalMs();
    } finally {
      release?.();
    }
  }
}

const governor = new GoogleApiGovernor();

export function waitForGoogleApiTurn(): Promise<void> {
  return governor.waitForTurn();
}

export function logGoogleApiGovernorConfig() {
  logInfo('google_api_governor_configured', {
    minIntervalMs: getMinIntervalMs(),
  });
}

