import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogMeta = Record<string, unknown>;

const severityByLevel: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const sensitiveKeyPattern = /(authorization|api.?key|token|secret|password|private.?key|client.?email|credential)/i;
const defaultLogLevel: LogLevel = 'info';
const configuredLogLevel = readLogLevel(process.env.LOG_LEVEL) || defaultLogLevel;

function readLogLevel(value: string | undefined): LogLevel | null {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }

  return null;
}

function shouldLog(level: LogLevel): boolean {
  return severityByLevel[level] >= severityByLevel[configuredLogLevel];
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return '[MaxDepth]';
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }

  if (typeof value === 'string') {
    return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      sensitiveKeyPattern.test(key) ? '[REDACTED]' : sanitize(entryValue, depth + 1),
    ])
  );
}

function writeLog(level: LogLevel, scope: string, message: string, meta?: LogMeta): void {
  if (!shouldLog(level)) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta: sanitize(meta) } : {}),
  };
  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
    return;
  }

  if (level === 'warn') {
    console.warn(line);
    return;
  }

  console.log(line);
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => writeLog('debug', scope, message, meta),
    info: (message, meta) => writeLog('info', scope, message, meta),
    warn: (message, meta) => writeLog('warn', scope, message, meta),
    error: (message, meta) => writeLog('error', scope, message, meta),
  };
}

const httpLogger = createLogger('http');

export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const headerRequestId = Array.isArray(req.headers['x-request-id'])
      ? req.headers['x-request-id'][0]
      : req.headers['x-request-id'];
    const requestId = typeof headerRequestId === 'string' && headerRequestId.length > 0
      ? headerRequestId
      : randomUUID();
    const startedAt = Date.now();

    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const level: LogLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      if (level === 'info' && durationMs < 1000) {
        return;
      }

      httpLogger[level](level === 'info' ? 'slow_request_completed' : 'request_failed', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
      });
    });

    next();
  };
}
