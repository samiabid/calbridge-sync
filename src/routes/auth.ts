import { Router, type Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { createOAuth2Client, getAuthUrl } from '../config/google';
import { google } from 'googleapis';
import { requireAuth } from '../middleware/auth';
import crypto from 'crypto';
import { decryptToken, encryptToken } from '../services/tokenCrypto';
import { getGoogleRedirectUri } from '../config/runtime';
import { logError, logInfo, logWarn } from '../services/logger';

const router = Router();
const prisma = new PrismaClient();
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

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

// Redirect to Google OAuth
router.get('/google', (req, res) => {
  const state = generateOAuthState();
  req.session.oauthState = state;
  req.session.oauthStateCreatedAt = Date.now();
  delete req.session.oauthReauthAccountId;
  const authUrl = getAuthUrl(state);
  logInfo('oauth_start', {
    mode: req.session.userId ? 'session_login' : 'login',
    redirectUri: getGoogleRedirectUri() || null,
  });
  res.redirect(authUrl);
});

// Google OAuth callback - for adding additional accounts
router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('No authorization code provided');
  }

  const oauthContext = consumeAndValidateOAuthState(req, state);
  if (!oauthContext.isValid) {
    logWarn('oauth_invalid_state', {
      hasCode: Boolean(code),
    });
    return res.status(400).send('Invalid OAuth state. Please try signing in again.');
  }

  try {
    const reauthAccountId = oauthContext.reauthAccountId;
    const oauth2Client = createOAuth2Client();

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code as string);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    if (!data.email) {
      logWarn('oauth_missing_email');
      return res.status(400).send('Could not retrieve user email');
    }

    const accessToken = tokens.access_token;
    if (!accessToken) {
      logWarn('oauth_missing_access_token', {
        email: data.email,
      });
      return res.status(400).send('Could not retrieve access token');
    }
    const encryptedAccessToken = encryptToken(accessToken);

    // If already logged in, always attach/update this Google account on the current user.
    if (req.session.userId) {
      const sessionUser = await prisma.user.findUnique({
        where: { id: req.session.userId },
      });

      if (!sessionUser) {
        req.session.destroy(() => {});
        return res.redirect('/');
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

        if (data.email !== targetAccount.displayName) {
          logWarn('oauth_reauth_account_mismatch', {
            authenticatedEmail: data.email,
            expectedEmail: targetAccount.displayName,
          });
          return res.status(400).send(
            `Authenticated as ${data.email}, but selected account is ${targetAccount.displayName}. Please re-authenticate using the correct Google account.`
          );
        }

        const accountRefreshToken = tokens.refresh_token || decryptToken(targetAccount.refreshToken);
        if (!accountRefreshToken) {
          logWarn('oauth_reauth_missing_refresh_token', {
            email: data.email,
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
            ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
          },
        });

        if (targetAccount.isPrimary) {
          await prisma.user.update({
            where: { id: sessionUser.id },
            data: {
              accessToken: encryptedAccessToken,
              ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
            },
          });
        }

        logInfo('oauth_reauth_success', {
          userId: sessionUser.id,
          accountId: targetAccount.id,
          email: data.email,
          receivedRefreshToken: Boolean(tokens.refresh_token),
        });
        return res.redirect('/dashboard');
      }

      const existingAccount = await prisma.googleAccount.findUnique({
        where: {
          userId_displayName: {
            userId: sessionUser.id,
            displayName: data.email,
          },
        },
      });

      const accountRefreshToken =
        tokens.refresh_token || (existingAccount ? decryptToken(existingAccount.refreshToken) : '');

      if (!existingAccount && !accountRefreshToken) {
        logWarn('oauth_add_account_missing_refresh_token', {
          email: data.email,
        });
        return res.status(400).send(
          'Google did not return a refresh token for this account. Remove this app from your Google account access and reconnect.'
        );
      }

      await prisma.googleAccount.upsert({
        where: {
          userId_displayName: {
            userId: sessionUser.id,
            displayName: data.email,
          },
        },
        update: {
          accessToken: encryptedAccessToken,
          ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
        },
        create: {
          userId: sessionUser.id,
          displayName: data.email,
          accessToken: encryptedAccessToken,
          refreshToken: encryptToken(accountRefreshToken),
          isPrimary: data.email === sessionUser.email,
        },
      });

      // If re-authing the primary login account, refresh User tokens too.
      if (data.email === sessionUser.email) {
        await prisma.user.update({
          where: { id: sessionUser.id },
          data: {
            accessToken: encryptedAccessToken,
            ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
          },
        });
      }

      logInfo('oauth_add_account_success', {
        userId: sessionUser.id,
        email: data.email,
        receivedRefreshToken: Boolean(tokens.refresh_token),
      });
      return res.redirect('/dashboard');
    }

    // Standard login flow (no existing session)
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      const userRefreshToken =
        tokens.refresh_token || decryptToken(existingUser.refreshToken) || '';
      if (!userRefreshToken) {
        logWarn('oauth_existing_user_missing_refresh_token', {
          email: data.email,
        });
        return res.status(400).send(
          'Google did not return a refresh token. Remove this app from your Google account access and sign in again.'
        );
      }

      await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          accessToken: encryptedAccessToken,
          ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
        },
      });

      await prisma.googleAccount.upsert({
        where: {
          userId_displayName: {
            userId: existingUser.id,
            displayName: data.email,
          },
        },
        update: {
          accessToken: encryptedAccessToken,
          ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
          isPrimary: true,
        },
        create: {
          userId: existingUser.id,
          displayName: data.email,
          accessToken: encryptedAccessToken,
          refreshToken: encryptToken(userRefreshToken),
          isPrimary: true,
        },
      });

      req.session.userId = existingUser.id;
      logInfo('oauth_login_success', {
        email: data.email,
        isNewUser: false,
        receivedRefreshToken: Boolean(tokens.refresh_token),
      });
      return res.redirect('/dashboard');
    }

    // New user
    if (!tokens.refresh_token) {
      logWarn('oauth_new_user_missing_refresh_token', {
        email: data.email,
      });
      return res.status(400).send(
        'Google did not return a refresh token. Remove this app from your Google account access and sign in again.'
      );
    }

    const user = await prisma.user.create({
      data: {
        email: data.email,
        accessToken: encryptedAccessToken,
        refreshToken: encryptToken(tokens.refresh_token),
        googleAccounts: {
          create: {
            displayName: data.email,
            accessToken: encryptedAccessToken,
            refreshToken: encryptToken(tokens.refresh_token),
            isPrimary: true,
          },
        },
      },
    });

    req.session.userId = user.id;
    logInfo('oauth_login_success', {
      email: data.email,
      isNewUser: true,
    });
    return res.redirect('/dashboard');
  } catch (error) {
    const message = getOAuthErrorMessage(error);
    logError('oauth_callback_failed', {
      error: error instanceof Error ? error.message : String(error),
      providerError: (error as any)?.response?.data?.error || null,
      redirectUri: getGoogleRedirectUri() || null,
    });
    res.status(500).send(message);
  }
});

// Add another Google account (must be logged in)
router.get('/google/add-account', requireAuth, (req, res) => {
  const state = generateOAuthState();
  req.session.oauthState = state;
  req.session.oauthStateCreatedAt = Date.now();
  delete req.session.oauthReauthAccountId;
  const authUrl = getAuthUrl(state);
  logInfo('oauth_start', {
    mode: 'add_account',
    userId: req.session.userId,
    redirectUri: getGoogleRedirectUri() || null,
  });
  res.redirect(authUrl);
});

// Re-authenticate an existing Google account (must be logged in)
router.get('/google/reauth/:accountId', requireAuth, async (req, res) => {
  try {
    const account = await prisma.googleAccount.findUnique({
      where: { id: req.params.accountId },
    });

    if (!account || account.userId !== req.session.userId) {
      return res.status(404).send('Google account not found');
    }

    const state = generateOAuthState();
    req.session.oauthState = state;
    req.session.oauthStateCreatedAt = Date.now();
    req.session.oauthReauthAccountId = account.id;

    const authUrl = getAuthUrl(state, {
      forceConsent: true,
      loginHint: account.displayName,
    });
    logInfo('oauth_start', {
      mode: 'reauth',
      userId: req.session.userId,
      accountId: account.id,
      accountEmail: account.displayName,
      redirectUri: getGoogleRedirectUri() || null,
    });
    return res.redirect(authUrl);
  } catch (error) {
    logError('oauth_reauth_start_failed', {
      error: error instanceof Error ? error.message : String(error),
      accountId: req.params.accountId,
    });
    return res.status(500).send('Failed to start re-authentication');
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/');
  });
});

export default router;
