const EMAIL_SPLIT_PATTERN = /[,\s;]+/;

export const PRIVATE_APP_AUTH_MESSAGE =
  'This calendar sync app is private. Ask the owner to allowlist your Google email before signing in.';

export function normalizeEmail(email: string | null | undefined): string {
  return (email || '').trim().toLowerCase();
}

export function parseAllowedEmails(value: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const item of (value || '').split(EMAIL_SPLIT_PATTERN)) {
    const email = normalizeEmail(item);
    if (email) {
      seen.add(email);
    }
  }
  return [...seen];
}

export function getAllowedLoginEmails(): string[] {
  return parseAllowedEmails(process.env.ALLOWED_LOGIN_EMAILS);
}

export function getAllowedGoogleAccountEmails(): string[] {
  return parseAllowedEmails(process.env.ALLOWED_GOOGLE_ACCOUNT_EMAILS);
}

function allowsEmail(email: string, allowedEmails: string[]): boolean {
  const normalizedEmail = normalizeEmail(email);
  return Boolean(normalizedEmail && allowedEmails.includes(normalizedEmail));
}

function allowWhenUnconfigured(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function isLoginEmailAllowed(email: string | null | undefined): boolean {
  const allowedEmails = getAllowedLoginEmails();
  if (allowedEmails.length === 0) {
    return allowWhenUnconfigured();
  }
  return allowsEmail(normalizeEmail(email), allowedEmails);
}

export function isGoogleAccountEmailAllowed(email: string | null | undefined): boolean {
  const allowedEmails = getAllowedGoogleAccountEmails();
  if (allowedEmails.length === 0) {
    return allowWhenUnconfigured();
  }
  return allowsEmail(normalizeEmail(email), allowedEmails);
}

export function isLoginAllowlistConfigured(): boolean {
  return getAllowedLoginEmails().length > 0;
}

export function isGoogleAccountAllowlistConfigured(): boolean {
  return getAllowedGoogleAccountEmails().length > 0;
}

export function getAccessControlSummary() {
  const loginAllowlistConfigured = isLoginAllowlistConfigured();
  const connectedAccountAllowlistConfigured = isGoogleAccountAllowlistConfigured();
  const production = process.env.NODE_ENV === 'production';

  return {
    privateAppMode: production || loginAllowlistConfigured || connectedAccountAllowlistConfigured,
    loginAllowlistConfigured,
    connectedAccountAllowlistConfigured,
    accessControlConfigured:
      !production || (loginAllowlistConfigured && connectedAccountAllowlistConfigured),
  };
}
