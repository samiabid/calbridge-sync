import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import authRoutes from './routes/auth';
import syncRoutes from './routes/sync';
import webhookRoutes from './routes/webhook';
import dashboardRoutes from './routes/dashboard';
import healthRoutes from './routes/health';
import { setupWebhookRenewal, stopWebhookRenewal } from './services/webhookRenewal';
import { ensureSyncColumns } from './services/schema';
import { assertProductionRuntimeConfig, getPublicBaseUrl } from './config/runtime';
import { logError, logInfo, logWarn } from './services/logger';
import { appRateLimiter, strictRateLimiter } from './middleware/rateLimit';
import { originCheck } from './middleware/originCheck';
import { requestContext } from './middleware/requestContext';
import { prisma } from './services/prisma';
import { logGoogleApiGovernorConfig } from './services/googleApiGovernor';
import { setupSyncMaintenance, stopSyncMaintenance } from './services/syncMaintenance';
import { drainWebhookProcessing } from './services/webhook';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const PgSession = connectPgSimple(session);
const isProduction = process.env.NODE_ENV === 'production';
// Production requires SESSION_SECRET via assertProductionRuntimeConfig; in dev
// a random per-boot secret just means sessions reset on restart.
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

assertProductionRuntimeConfig();

if (isProduction && !getPublicBaseUrl()) {
  logWarn('public_url_not_configured');
}

// Required when running behind Railway proxy so secure cookies work correctly.
app.set('trust proxy', 1);

// Middleware
app.use(requestContext);
// CSP stays off until the dashboard's inline scripts are extracted; the other
// helmet defaults (nosniff, frame denial, HSTS, referrer policy) apply.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(originCheck);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Session configuration
app.use(session({
  store: new PgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'Session',
    createTableIfMissing: false,
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Routes
// Rate limits are mounted on the prefixes (not inside routers) so the
// router-level tests are unaffected. /webhook/google and the health routes
// are deliberately unlimited (Google's callers and Railway healthchecks).
app.use('/auth', strictRateLimiter, authRoutes);
app.use('/webhook/internal', strictRateLimiter);
app.use('/sync', appRateLimiter, syncRoutes);
app.use('/dashboard', appRateLimiter, dashboardRoutes);
app.use('/webhook', webhookRoutes);
app.use('/', healthRoutes);

app.get('/', (req, res) => {
  res.render('index', { user: req.session.userId });
});

async function startServer() {
  await ensureSyncColumns();
  logGoogleApiGovernorConfig();

  // Setup webhook renewal cron job
  setupWebhookRenewal();
  setupSyncMaintenance();

  // Start server
  const server = app.listen(PORT, () => {
    logInfo('server_started', {
      port: Number(PORT),
      environment: process.env.NODE_ENV || 'development',
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo('shutdown_started', { signal });

    // Hard exit if draining takes too long (Railway sends SIGKILL soon after anyway).
    setTimeout(() => {
      logError('shutdown_forced_exit');
      process.exit(1);
    }, 10_000).unref();

    stopWebhookRenewal();
    stopSyncMaintenance();
    server.close(async () => {
      const drained = await drainWebhookProcessing(8_000);
      if (!drained) logWarn('shutdown_webhook_drain_timed_out');
      await prisma.$disconnect().catch(() => {});
      logInfo('shutdown_completed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((error) => {
  logError('server_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
