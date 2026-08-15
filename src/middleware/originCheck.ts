import { NextFunction, Request, Response } from 'express';
import { getPublicBaseUrl } from '../config/runtime';
import { logWarn } from '../services/logger';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Defense-in-depth CSRF protection: session cookies are already
// sameSite: 'lax', so cross-site POSTs don't carry them in modern browsers.
// This rejects mutating requests whose Origin doesn't match the app's own
// URL. Webhooks are excluded (Google's callers send no browser Origin).
export function originCheck(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method) || req.path.startsWith('/webhook')) {
    return next();
  }

  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') {
    return next();
  }

  const allowed = new Set<string>();
  const publicUrl = getPublicBaseUrl();
  if (publicUrl) allowed.add(publicUrl);
  if (process.env.NODE_ENV !== 'production') {
    const port = process.env.PORT || 3000;
    allowed.add(`http://localhost:${port}`);
    allowed.add(`http://127.0.0.1:${port}`);
  }

  if (allowed.has(origin.replace(/\/+$/, ''))) {
    return next();
  }

  logWarn('origin_check_rejected', {
    origin,
    method: req.method,
    path: req.path,
  });
  res.status(403).json({ error: 'Cross-origin request rejected' });
}
