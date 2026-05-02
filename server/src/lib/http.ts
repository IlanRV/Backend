import { NextFunction, Request, RequestHandler, Response } from 'express';
import { createLogger } from './logger';

const logger = createLogger('http-utils');

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export function createHttpError(statusCode: number, message: string): HttpError {
  return new HttpError(statusCode, message);
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch((error: unknown) => {
      logger.debug('async_handler_rejected', {
        method: req.method,
        path: req.originalUrl,
        error,
      });
      next(error);
    });
  };
}

export function getRouteParam(req: Request, name: string): string {
  const value = req.params[name];

  if (Array.isArray(value)) {
    return value[0] || '';
  }

  return value || '';
}
