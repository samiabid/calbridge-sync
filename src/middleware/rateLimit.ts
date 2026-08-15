import rateLimit from 'express-rate-limit';

// Single-replica deployment (railway.json numReplicas: 1), so the default
// in-memory store is sufficient.

// OAuth flows are a handful of redirects per login; internal endpoints are
// token-gated cron calls. Tight limit blunts brute-forcing.
export const strictRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// The events dashboard fires a request per filter change, so keep app-route
// limits generous enough that a single active user never hits them.
export const appRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
