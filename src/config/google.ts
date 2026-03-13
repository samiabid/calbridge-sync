import { google } from 'googleapis';
import { getGoogleRedirectUri } from './runtime';

export function createOAuth2Client() {
  const redirectUri = getGoogleRedirectUri();

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function getAuthUrl(state: string, options?: { forceConsent?: boolean; loginHint?: string }) {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    include_granted_scopes: true,
    ...(options?.forceConsent ? { prompt: 'consent' } : {}),
    ...(options?.loginHint ? { login_hint: options.loginHint } : {}),
    state,
  });
}
