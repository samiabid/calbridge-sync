import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import dotenv from 'dotenv';
import path from 'path';
import authRoutes from './routes/auth';
import syncRoutes from './routes/sync';
import webhookRoutes from './routes/webhook';
import dashboardRoutes from './routes/dashboard';
import healthRoutes from './routes/health';
import { setupWebhookRenewal } from './services/webhookRenewal';
import { ensureSyncColumns } from './services/schema';
import { isTokenEncryptionEnabled } from './services/tokenCrypto';
import { getPublicBaseUrl } from './config/runtime';
import { logError, logInfo, logWarn } from './services/logger';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const PgSession = connectPgSimple(session);
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

if (isProduction && !sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production');
}

if (isProduction && !isTokenEncryptionEnabled()) {
  logWarn('token_encryption_not_configured');
}

if (isProduction && !getPublicBaseUrl()) {
  logWarn('public_url_not_configured');
}

// Required when running behind Railway proxy so secure cookies work correctly.
app.set('trust proxy', 1);

// Middleware
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
  secret: sessionSecret || 'dev-session-secret-change-me',
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
app.use('/auth', authRoutes);
app.use('/sync', syncRoutes);
app.use('/webhook', webhookRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/', healthRoutes);

app.get('/', (req, res) => {
  res.render('index', { user: req.session.userId });
});

async function startServer() {
  await ensureSyncColumns();

  // Setup webhook renewal cron job
  setupWebhookRenewal();

  // Start server
  app.listen(PORT, () => {
    logInfo('server_started', {
      port: Number(PORT),
      environment: process.env.NODE_ENV || 'development',
    });
  });
}

startServer().catch((error) => {
  logError('server_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
});
