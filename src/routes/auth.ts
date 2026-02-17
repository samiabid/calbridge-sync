import { Router, type Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { createOAuth2Client, getAuthUrl } from '../config/google';
import { google } from 'googleapis';
import { requireAuth } from '../middleware/auth';
import crypto from 'crypto';
import { decryptToken, encryptToken } from '../services/tokenCrypto';

const router = Router();
const prisma = new PrismaClient();
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function generateOAuthState(): string {
  return crypto.randomBytes(24).toString('hex');
}

function consumeAndValidateOAuthState(req: Request, stateFromQuery: unknown): boolean {
  const expectedState = req.session.oauthState;
  const createdAt = req.session.oauthStateCreatedAt;

  // One-time use to prevent replay, regardless of success.
  delete req.session.oauthState;
  delete req.session.oauthStateCreatedAt;

  if (!expectedState || typeof stateFromQuery !== 'string' || typeof createdAt !== 'number') {
    return false;
  }

  if (Date.now() - createdAt > OAUTH_STATE_MAX_AGE_MS) {
    return false;
  }

  const receivedBuffer = Buffer.from(stateFromQuery);
  const expectedBuffer = Buffer.from(expectedState);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

// Redirect to Google OAuth
router.get('/google', (req, res) => {
  const state = generateOAuthState();
  req.session.oauthState = state;
  req.session.oauthStateCreatedAt = Date.now();
  const authUrl = getAuthUrl(state);
  res.redirect(authUrl);
});

// Google OAuth callback - for adding additional accounts
router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('No authorization code provided');
  }

  if (!consumeAndValidateOAuthState(req, state)) {
    return res.status(400).send('Invalid OAuth state. Please try signing in again.');
  }

  try {
    const oauth2Client = createOAuth2Client();

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code as string);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    if (!data.email) {
      return res.status(400).send('Could not retrieve user email');
    }

    const accessToken = tokens.access_token;
    if (!accessToken) {
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
      return res.redirect('/dashboard');
    }

    // New user
    if (!tokens.refresh_token) {
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
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Error during authentication:', error);
    res.status(500).send('Authentication failed');
  }
});

// Add another Google account (must be logged in)
router.get('/google/add-account', requireAuth, (req, res) => {
  const state = generateOAuthState();
  req.session.oauthState = state;
  req.session.oauthStateCreatedAt = Date.now();
  const authUrl = getAuthUrl(state);
  res.redirect(authUrl);
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
