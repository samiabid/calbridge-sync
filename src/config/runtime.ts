import { getAccessControlSummary } from './accessControl';

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeDomain(domain: string): string {
  const trimmed = trimTrailingSlashes(domain.trim());
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export const CANONICAL_PUBLIC_URL = 'https://calendar.samiabid.com';

export function getPublicBaseUrl(): string {
  const explicit = process.env.PUBLIC_URL?.trim();
  if (explicit) {
    return trimTrailingSlashes(explicit);
  }

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
  if (!railwayDomain) {
    return '';
  }

  return trimTrailingSlashes(normalizeDomain(railwayDomain));
}

export function getGoogleRedirectUri(): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit) {
    return explicit;
  }

  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    return '';
  }

  return `${baseUrl}/auth/google/callback`;
}

export function isCanonicalPublicUrlConfigured(): boolean {
  return getPublicBaseUrl() === CANONICAL_PUBLIC_URL;
}

export function getRuntimeConfigSummary() {
  return {
    canonicalPublicUrl: CANONICAL_PUBLIC_URL,
    publicUrl: getPublicBaseUrl() || null,
    googleRedirectUri: getGoogleRedirectUri() || null,
    canonicalPublicUrlConfigured: isCanonicalPublicUrlConfigured(),
    googleClientConfigured: Boolean(
      process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()
    ),
    googleRedirectUriConfigured: Boolean(getGoogleRedirectUri()),
    accessControl: getAccessControlSummary(),
  };
}

export function assertProductionRuntimeConfig() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const missing: string[] = [];
  const summary = getRuntimeConfigSummary();

  if (!process.env.SESSION_SECRET?.trim()) missing.push('SESSION_SECRET');
  if (!process.env.TOKEN_ENCRYPTION_KEY?.trim()) missing.push('TOKEN_ENCRYPTION_KEY');
  if (!process.env.GOOGLE_CLIENT_ID?.trim()) missing.push('GOOGLE_CLIENT_ID');
  if (!process.env.GOOGLE_CLIENT_SECRET?.trim()) missing.push('GOOGLE_CLIENT_SECRET');
  if (!summary.publicUrl) missing.push('PUBLIC_URL');
  if (!summary.googleRedirectUri) missing.push('GOOGLE_REDIRECT_URI or PUBLIC_URL');
  if (!process.env.INTERNAL_CRON_TOKEN?.trim()) missing.push('INTERNAL_CRON_TOKEN');
  if (!summary.accessControl.loginAllowlistConfigured) missing.push('ALLOWED_LOGIN_EMAILS');
  if (!summary.accessControl.connectedAccountAllowlistConfigured) {
    missing.push('ALLOWED_GOOGLE_ACCOUNT_EMAILS');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required production config: ${missing.join(', ')}`);
  }
}
