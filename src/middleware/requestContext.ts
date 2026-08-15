import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { logInfo } from '../services/logger';
import { runWithRequestContext } from '../services/requestContext';

const QUIET_PATHS = new Set(['/health', '/ready']);

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const headerValue = req.headers['x-request-id'];
  const requestId =
    (typeof headerValue === 'string' && headerValue.trim()) || randomUUID();
  (req as any).id = requestId;
  res.setHeader('x-request-id', requestId);

  const startedAt = Date.now();
  if (!QUIET_PATHS.has(req.path)) {
    res.on('finish', () => {
      logInfo('request_completed', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
  }

  runWithRequestContext({ requestId }, () => next());
}
