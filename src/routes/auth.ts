import { Router, type Request, type Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createOAuth2Client, getAuthUrl as buildGoogleAuthUrl } from '../config/google';
import { google } from 'googleapis';
import { requireAuth } from '../middleware/auth';
import crypto from 'crypto';
import { decryptToken, encryptToken } from '../services/tokenCrypto';
import { getGoogleRedirectUri } from '../config/runtime';
import { logError, logInfo, logWarn } from '../services/logger';
import {
  PRIVATE_APP_AUTH_MESSAGE,
  getAccessControlSummary,
  isGoogleAccountEmailAllowed,
  isLoginEmailAllowed,
  normalizeEmail,
} from '../config/accessControl';

const defaultPrisma = new PrismaClient();
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface AuthRouteDeps {
  prisma?: any;
  createOAuth2Client?: typeof createOAuth2Client;
  getAuthUrl?: typeof buildGoogleAuthUrl;
  getOAuthUserInfo?: (oauth2Client: any) => Promise<{ email?: string | null }>;
  getRedirectUri?: typeof getGoogleRedirectUri;
  encryptToken?: typeof encryptToken;
  decryptToken?: typeof decryptToken;
  isLoginEmailAllowed?: typeof isLoginEmailAllowed;
  isGoogleAccountEmailAllowed?: typeof isGoogleAccountEmailAllowed;
  getAccessControlSummary?: typeof getAccessControlSummary;
  logInfo?: typeof logInfo;
  logWarn?: typeof logWarn;
  logError?: typeof logError;
}

async function fetchOAuthUserInfo(oauth2Client: any) {
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  return data;
}

function generateOAuthState(): string {
  return crypto.randomBytes(24).toString('hex');
}

function getOAuthErrorMessage(error: any): string {
  const providerError =
    error?.response?.data?.error_description ||
    error?.response?.data?.error ||
    error?.message ||
    String(error);
  const normalized = String(providerError).toLowerCase();

  if (normalized.includes('redirect_uri_mismatch')) {
    return 'Google rejected the OAuth redirect URL. Verify the authorized redirect URI exactly matches this app domain.';
  }

  if (normalized.includes('invalid_grant')) {
    return 'Google rejected the OAuth grant. Reconnect the Google account and confirm the OAuth consent screen is published to production.';
  }

  if (normalized.includes('access_denied')) {
    return 'Google access was denied. Please approve the requested calendar permissions to continue.';
  }

  return 'Authentication failed. Please try again or re-authenticate the Google account.';
}

function consumeAndValidateOAuthState(
  req: Request,
  stateFromQuery: unknown
): { isValid: boolean; reauthAccountId?: string } {
  const expectedState = req.session.oauthState;
  const createdAt = req.session.oauthStateCreatedAt;
  const reauthAccountId = req.session.oauthReauthAccountId;

  // One-time use to prevent replay, regardless of success.
  delete req.session.oauthState;
  delete req.session.oauthStateCreatedAt;
  delete req.session.oauthReauthAccountId;

  if (!expectedState || typeof stateFromQuery !== 'string' || typeof createdAt !== 'number') {
    return { isValid: false };
  }

  if (Date.now() - createdAt > OAUTH_STATE_MAX_AGE_MS) {
    return { isValid: false };
  }

  const receivedBuffer = Buffer.from(stateFromQuery);
  const expectedBuffer = Buffer.from(expectedState);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return { isValid: false };
  }

  if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return { isValid: false };
  }

  return { isValid: true, reauthAccountId };
}

function sendPrivateAppResponse(res: Response, statusCode = 403) {
  return res.status(statusCode).send(PRIVATE_APP_AUTH_MESSAGE);
}

function sendPrivateAppConfigResponse(res: Response) {
  return res
    .status(503)
    .send('This private calendar sync app is not configured for sign-in yet.');
}

function encryptAccessTokenOrRespond(
  tokens: any,
  email: string,
  encryptTokenFn: typeof encryptToken,
  warn: typeof logWarn,
  res: Response
): string | null {
  const accessToken = tokens.access_token;
  if (!accessToken) {
    warn('oauth_missing_access_token', { email });
    res.status(400).send('Could not retrieve access token');
    return null;
  }
  return encryptTokenFn(accessToken);
}

export function buildAuthRouter(deps: AuthRouteDeps = {}) {
  const router = Router();
  const prisma = deps.prisma || defaultPrisma;
  const createOAuthClient = deps.createOAuth2Client || createOAuth2Client;
  const getAuthUrl = deps.getAuthUrl || buildGoogleAuthUrl;
  const getOAuthUserInfo = deps.getOAuthUserInfo || fetchOAuthUserInfo;
  const getRedirectUri = deps.getRedirectUri || getGoogleRedirectUri;
  const encryptTokenFn = deps.encryptToken || encryptToken;
  const decryptTokenFn = deps.decryptToken || decryptToken;
  const isLoginEmailAllowedFn = deps.isLoginEmailAllowed || isLoginEmailAllowed;
  const isGoogleAccountEmailAllowedFn =
    deps.isGoogleAccountEmailAllowed || isGoogleAccountEmailAllowed;
  const getAccessControlSummaryFn = deps.getAccessControlSummary || getAccessControlSummary;
  const info = deps.logInfo || logInfo;
  const warn = deps.logWarn || logWarn;
  const errorLog = deps.logError || logError;

  // Redirect to Google OAuth
  router.get('/google', (req, res) => {
    const accessControl = getAccessControlSummaryFn();
    if (!accessControl.loginAllowlistConfigured && process.env.NODE_ENV === 'production') {
      warn('oauth_login_allowlist_missing');
      return sendPrivateAppConfigResponse(res);
    }

    const state = generateOAuthState();
    req.session.oauthState = state;
    req.session.oauthStateCreatedAt = Date.now();
    delete req.session.oauthReauthAccountId;
    const authUrl = getAuthUrl(state);
    info('oauth_start', {
      mode: req.session.userId ? 'session_login' : 'login',
      redirectUri: getRedirectUri() || null,
    });
    return res.redirect(authUrl);
  });

  // Google OAuth callback - for sign-in, adding accounts, and re-authentication.
  router.get('/google/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).send('No authorization code provided');
    }

    const oauthContext = consumeAndValidateOAuthState(req, state);
    if (!oauthContext.isValid) {
      warn('oauth_invalid_state', {
        hasCode: Boolean(code),
      });
      return res.status(400).send('Invalid OAuth state. Please try signing in again.');
    }

    try {
      const reauthAccountId = oauthContext.reauthAccountId;
      const oauth2Client = createOAuthClient();

      // Exchange code for tokens.
      const { tokens } = await oauth2Client.getToken(code as string);
      oauth2Client.setCredentials(tokens);

      // Get user info.
      const data = await getOAuthUserInfo(oauth2Client);
      const authenticatedEmail = normalizeEmail(data.email);

      if (!authenticatedEmail) {
        warn('oauth_missing_email');
        return res.status(400).send('Could not retrieve user email');
      }

      // If already logged in, always attach/update this Google account on the current user.
      if (req.session.userId) {
        const sessionUser = await prisma.user.findUnique({
          where: { id: req.session.userId },
        });

        if (!sessionUser) {
          req.session.destroy(() => {});
          return res.redirect('/');
        }

        if (!isLoginEmailAllowedFn(sessionUser.email)) {
          warn('oauth_session_user_not_allowed', {
            userId: sessionUser.id,
            email: sessionUser.email,
          });
          req.session.destroy(() => {});
          return sendPrivateAppResponse(res);
        }

        if (reauthAccountId) {
          const targetAccount = await prisma.googleAccount.findUnique({
            where: { id: reauthAccountId },
          });

          if (!targetAccount || targetAccount.userId !== sessionUser.id) {
            return res
              .status(400)
              .send('Selected account for re-authentication was not found. Please try again.');
          }

          if (!isGoogleAccountEmailAllowedFn(targetAccount.displayName)) {
            warn('oauth_reauth_account_not_allowed', {
              userId: sessionUser.id,
              accountId: targetAccount.id,
              email: targetAccount.displayName,
            });
            return sendPrivateAppResponse(res);
          }

          if (normalizeEmail(authenticatedEmail) !== normalizeEmail(targetAccount.displayName)) {
            warn('oauth_reauth_account_mismatch', {
              authenticatedEmail,
              expectedEmail: targetAccount.displayName,
            });
            return res.status(400).send(
              `Authenticated as ${authenticatedEmail}, but selected account is ${targetAccount.displayName}. Please re-authenticate using the correct Google account.`
            );
          }

          const encryptedAccessToken = encryptAccessTokenOrRespond(
            tokens,
            authenticatedEmail,
            encryptTokenFn,
            warn,
            res
          );
          if (!encryptedAccessToken) return undefined;

          const accountRefreshToken = tokens.refresh_token || decryptTokenFn(targetAccount.refreshToken);
          if (!accountRefreshToken) {
            warn('oauth_reauth_missing_refresh_token', {
              email: authenticatedEmail,
              accountId: targetAccount.id,
            });
            return res.status(400).send(
              'Google did not return a refresh token for this account. Remove this app from your Google account access and reconnect.'
            );
          }

          await prisma.googleAccount.update({
            where: { id: targetAccount.id },
            data: {
              accessToken: encryptedAccessToken,
              ...(tokens.refresh_token ? { refreshToken: encryptTokenFn(tokens.refresh_token) } : {}),
            },
          });

          if (targetAccount.isPrimary) {
            await prisma.user.update({
              where: { id: sessionUser.id },
              data: {
                accessToken: encryptedAccessToken,
                ...(tokens.refresh_token ? { refreshToken: encryptTokenFn(tokens.refresh_token) } : {}),
              },
            });
          }

          info('oauth_reauth_success', {
            userId: sessionUser.id,
            accountId: targetAccount.id,
            email: authenticatedEmail,
            receivedRefreshToken: Boolean(tokens.refresh_token),
          });
          return res.redirect('/dashboard');
        }

        if (!isGoogleAccountEmailAllowedFn(authenticatedEmail)) {
          warn('oauth_add_account_email_not_allowed', {
            userId: sessionUser.id,
            email: authenticatedEmail,
          });
          return sendPrivateAppResponse(res);
        }

        const encryptedAccessToken = encryptAccessTokenOrRespond(
          tokens,
          authenticatedEmail,
          encryptTokenFn,
          warn,
          res
        );
        if (!encryptedAccessToken) return undefined;

        const existingAccount = await prisma.googleAccount.findUnique({
          where: {
            userId_displayName: {
              userId: sessionUser.id,
              displayName: authenticatedEmail,
            },
          },
        });

        const accountRefreshToken =
          tokens.refresh_token || (existingAccount ? decryptTokenFn(existingAccount.refreshToken) : '');

        if (!existingAccount && !accountRefreshToken) {
          warn('oauth_add_account_missing_refresh_token', {
            email: authenticatedEmail,
          });
          return res.status(400).send(
            'Google did not return a refresh token for this account. Remove this app from your Google account access and reconnect.'
          );
        }

        await prisma.googleAccount.upsert({
          where: {
            userId_displayName: {
              userId: sessionUser.id,
              displayName: authenticatedEmail,
            },
          },
          update: {
            accessToken: encryptedAccessToken,
            ...(tokens.refresh_token ? { refreshToken: encryptTokenFn(tokens.refresh_token) } : {}),
          },
          create: {
            userId: sessionUser.id,
            displayName: authenticatedEmail,
            accessToken: encryptedAccessToken,
            refreshToken: encryptTokenFn(accountRefreshToken),
            isPrimary: normalizeEmail(authenticatedEmail) === normalizeEmail(sessionUser.email),
          },
        });

        // If re-authing the primary login account, refresh User tokens too.
        if (normalizeEmail(authenticatedEmail) === normalizeEmail(sessionUser.email)) {
          await prisma.user.update({
            where: { id: sessionUser.id },
            data: {
              accessToken: encryptedAccessToken,
              ...(tokens.refresh_token ? { refreshToken: encryptTokenFn(tokens.refresh_token) } : {}),
            },
          });
        }

        info('oauth_add_account_success', {
          userId: sessionUser.id,
          email: authenticatedEmail,
          receivedRefreshToken: Boolean(tokens.refresh_token),
        });
        return res.redirect('/dashboard');
      }

      // Standard login flow (no existing session).
      if (!isLoginEmailAllowedFn(authenticatedEmail)) {
        warn('oauth_login_email_not_allowed', {
          email: authenticatedEmail,
        });
        return sendPrivateAppResponse(res);
      }

      if (!isGoogleAccountEmailAllowedFn(authenticatedEmail)) {
        warn('oauth_login_google_account_not_allowed', {
          email: authenticatedEmail,
        });
        return sendPrivateAppResponse(res);
      }

      const encryptedAccessToken = encryptAccessTokenOrRespond(
        tokens,
        authenticatedEmail,
        encryptTokenFn,
        warn,
        res
      );
      if (!encryptedAccessToken) return undefined;

      const existingUser = await prisma.user.findUnique({
        where: { email: authenticatedEmail },
      });

      if (existingUser) {
        const userRefreshToken =
          tokens.refresh_token || decryptTokenFn(existingUser.refreshToken) || '';
        if (!userRefreshToken) {
          warn('oauth_existing_user_missing_refresh_token', {
            email: authenticatedEmail,
          });
          return res.status(400).send(
            'Google did not return a refresh token. Remove this app from your Google account access and sign in again.'
          );
        }

        await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            accessToken: encryptedAccessToken,
            ...(tokens.refresh_token ? { refreshToken: encryptTokenFn(tokens.refresh_token) } : {}),
          },
        });

        await prisma.googleAccount.upsert({
          where: {
            userId_displayName: {
              userId: existingUser.id,
              displayName: authenticatedEmail,
            },
          },
          update: {
            accessToken: encryptedAccessToken,
            ...(tokens.refresh_token ? { refreshToken: encryptTokenFn(tokens.refresh_token) } : {}),
            isPrimary: true,
          },
          create: {
            userId: existingUser.id,
            displayName: authenticatedEmail,
            accessToken: encryptedAccessToken,
            refreshToken: encryptTokenFn(userRefreshToken),
            isPrimary: true,
          },
        });

        req.session.userId = existingUser.id;
        info('oauth_login_success', {
          email: authenticatedEmail,
          isNewUser: false,
          receivedRefreshToken: Boolean(tokens.refresh_token),
        });
        return res.redirect('/dashboard');
      }

      // New user.
      if (!tokens.refresh_token) {
        warn('oauth_new_user_missing_refresh_token', {
          email: authenticatedEmail,
        });
        return res.status(400).send(
          'Google did not return a refresh token. Remove this app from your Google account access and sign in again.'
        );
      }

      const user = await prisma.user.create({
        data: {
          email: authenticatedEmail,
          accessToken: encryptedAccessToken,
          refreshToken: encryptTokenFn(tokens.refresh_token),
          googleAccounts: {
            create: {
              displayName: authenticatedEmail,
              accessToken: encryptedAccessToken,
              refreshToken: encryptTokenFn(tokens.refresh_token),
              isPrimary: true,
            },
          },
        },
      });

      req.session.userId = user.id;
      info('oauth_login_success', {
        email: authenticatedEmail,
        isNewUser: true,
      });
      return res.redirect('/dashboard');
    } catch (error) {
      const message = getOAuthErrorMessage(error);
      errorLog('oauth_callback_failed', {
        error: error instanceof Error ? error.message : String(error),
        providerError: (error as any)?.response?.data?.error || null,
        redirectUri: getRedirectUri() || null,
      });
      return res.status(500).send(message);
    }
  });

  // Add another Google account (must be logged in).
  router.get('/google/add-account', requireAuth, (req, res) => {
    const accessControl = getAccessControlSummaryFn();
    if (!accessControl.connectedAccountAllowlistConfigured && process.env.NODE_ENV === 'production') {
      warn('oauth_connected_account_allowlist_missing', {
        userId: req.session.userId,
      });
      return sendPrivateAppConfigResponse(res);
    }

    const state = generateOAuthState();
    req.session.oauthState = state;
    req.session.oauthStateCreatedAt = Date.now();
    delete req.session.oauthReauthAccountId;
    const authUrl = getAuthUrl(state);
    info('oauth_start', {
      mode: 'add_account',
      userId: req.session.userId,
      redirectUri: getRedirectUri() || null,
    });
    return res.redirect(authUrl);
  });

  // Re-authenticate an existing Google account (must be logged in).
  router.get('/google/reauth/:accountId', requireAuth, async (req, res) => {
    try {
      const account = await prisma.googleAccount.findUnique({
        where: { id: req.params.accountId },
      });

      if (!account || account.userId !== req.session.userId) {
        return res.status(404).send('Google account not found');
      }

      if (!isGoogleAccountEmailAllowedFn(account.displayName)) {
        warn('oauth_reauth_account_not_allowed', {
          userId: req.session.userId,
          accountId: account.id,
          email: account.displayName,
        });
        return sendPrivateAppResponse(res);
      }

      const state = generateOAuthState();
      req.session.oauthState = state;
      req.session.oauthStateCreatedAt = Date.now();
      req.session.oauthReauthAccountId = account.id;

      const authUrl = getAuthUrl(state, {
        forceConsent: true,
        loginHint: account.displayName,
      });
      info('oauth_start', {
        mode: 'reauth',
        userId: req.session.userId,
        accountId: account.id,
        accountEmail: account.displayName,
        redirectUri: getRedirectUri() || null,
      });
      return res.redirect(authUrl);
    } catch (error) {
      errorLog('oauth_reauth_start_failed', {
        error: error instanceof Error ? error.message : String(error),
        accountId: req.params.accountId,
      });
      return res.status(500).send('Failed to start re-authentication');
    }
  });

  // Logout.
  router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
      }
      res.redirect('/');
    });
  });

  return router;
}

export default buildAuthRouter();
