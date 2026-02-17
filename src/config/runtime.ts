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
