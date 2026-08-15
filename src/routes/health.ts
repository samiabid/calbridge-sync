import { Router } from 'express';
import packageJson from '../../package.json';
import { getPublicBaseUrl, getRuntimeConfigSummary } from '../config/runtime';
import { isTokenEncryptionEnabled } from '../services/tokenCrypto';
import { getWebhookRenewalStatus } from '../services/webhookRenewal';
import { hasValidInternalToken } from '../utils/security';
import { prisma } from '../services/prisma';
import { getSyncMaintenanceStatus } from '../services/syncMaintenance';
import { getSyncCanaryStatus } from '../services/syncCanary';


function getAppMetadata() {
  return {
    service: 'calendar-sync-app',
    version: packageJson.version,
    environment: process.env.NODE_ENV || 'development',
    commit:
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.SOURCE_VERSION ||
      process.env.GITHUB_SHA ||
      null,
  };
}

interface HealthRouteDeps {
  queryDatabase?: () => Promise<void>;
  getPublicUrl?: () => string | null | undefined;
  getRuntimeConfig?: () => ReturnType<typeof getRuntimeConfigSummary>;
  isTokenEncryptionReady?: () => boolean;
  getRenewalStatus?: typeof getWebhookRenewalStatus;
  getMaintenanceStatus?: typeof getSyncMaintenanceStatus;
  getMetadata?: () => ReturnType<typeof getAppMetadata>;
}

export function buildHealthRouter(deps: HealthRouteDeps = {}) {
  const router = Router();
  const queryDatabase =
    deps.queryDatabase ||
    (async () => {
      await prisma.$queryRawUnsafe('SELECT 1');
    });
  const getPublicUrl = deps.getPublicUrl || getPublicBaseUrl;
  const getRuntimeConfig = deps.getRuntimeConfig || getRuntimeConfigSummary;
  const isTokenEncryptionReady = deps.isTokenEncryptionReady || isTokenEncryptionEnabled;
  const getRenewalStatus = deps.getRenewalStatus || getWebhookRenewalStatus;
  const getMaintenanceStatus = deps.getMaintenanceStatus || getSyncMaintenanceStatus;
  const getMetadata = deps.getMetadata || getAppMetadata;

  // Unauthenticated liveness probe: no version/commit/environment details.
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', async (req, res) => {
    const timestamp = new Date().toISOString();
    const metadata = getMetadata();
    const runtimeConfig = getRuntimeConfig();
    const webhookRenewal = getRenewalStatus();
    const syncMaintenance = getMaintenanceStatus();
    const isProduction = metadata.environment === 'production';
    const checks = {
      database: false,
      sessionConfigured: Boolean(process.env.DATABASE_URL) && Boolean(process.env.SESSION_SECRET || process.env.NODE_ENV !== 'production'),
      tokenEncryptionConfigured: isTokenEncryptionReady(),
      publicUrlConfigured: Boolean(getPublicUrl()),
      canonicalPublicUrlConfigured: runtimeConfig.canonicalPublicUrlConfigured,
      googleClientConfigured: runtimeConfig.googleClientConfigured,
      googleRedirectUriConfigured: runtimeConfig.googleRedirectUriConfigured,
      accessControlConfigured: runtimeConfig.accessControl.accessControlConfigured,
      loginAllowlistConfigured: runtimeConfig.accessControl.loginAllowlistConfigured,
      connectedAccountAllowlistConfigured:
        runtimeConfig.accessControl.connectedAccountAllowlistConfigured,
      internalRenewalTokenConfigured: Boolean(process.env.INTERNAL_CRON_TOKEN),
      alertWebhookConfigured: Boolean(process.env.ALERT_WEBHOOK_URL),
      webhookRenewalScheduled: webhookRenewal.status !== 'not_scheduled',
      syncMaintenanceScheduled: syncMaintenance.status !== 'not_scheduled',
    };

    let databaseError: string | null = null;

    try {
      await queryDatabase();
      checks.database = true;
    } catch (error: any) {
      databaseError = error instanceof Error ? error.message : String(error);
    }

    const productionChecksHealthy =
      !isProduction ||
      (checks.tokenEncryptionConfigured &&
        checks.publicUrlConfigured &&
        checks.canonicalPublicUrlConfigured &&
        checks.googleClientConfigured &&
        checks.googleRedirectUriConfigured &&
        checks.accessControlConfigured &&
        checks.loginAllowlistConfigured &&
        checks.connectedAccountAllowlistConfigured &&
        checks.internalRenewalTokenConfigured);
    const ok =
      checks.database &&
      checks.sessionConfigured &&
      checks.webhookRenewalScheduled &&
      checks.syncMaintenanceScheduled &&
      productionChecksHealthy &&
      webhookRenewal.status !== 'error' &&
      syncMaintenance.status !== 'error';

    // Full diagnostics for the internal cron token or a logged-in session
    // (the dashboard's readiness card fetches /ready from the browser);
    // Railway healthchecks and anonymous callers get the status code plus a
    // minimal body.
    const isLoggedInSession = Boolean((req as any).session?.userId);
    if (!isLoggedInSession && !hasValidInternalToken(req, process.env.INTERNAL_CRON_TOKEN)) {
      res.status(ok ? 200 : 503).json({ ok, timestamp });
      return;
    }

    res.status(ok ? 200 : 503).json({
      ok,
      ...metadata,
      timestamp,
      checks,
      runtimeConfig,
      databaseError,
      webhookRenewal,
      syncMaintenance,
      syncCanary: getSyncCanaryStatus(),
    });
  });

  return router;
}

export default buildHealthRouter();
