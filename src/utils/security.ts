import crypto from 'crypto';

export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

export function hasValidInternalToken(req: any, configuredToken: string | undefined): boolean {
  if (!configuredToken) return false;

  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : null;
  const headerToken = req.headers['x-internal-token'];
  const providedToken =
    bearerToken ||
    (typeof headerToken === 'string' ? headerToken.trim() : Array.isArray(headerToken) ? headerToken[0] : null);

  return typeof providedToken === 'string' && safeEqual(providedToken, configuredToken);
}
