import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadLogger(logLevel?: string, nodeEnv?: string) {
  vi.resetModules();
  const originalEnv = { ...process.env };
  process.env = { ...originalEnv, LOG_LEVEL: logLevel, NODE_ENV: nodeEnv };
  const module = await import('../../src/lib/logger');
  process.env = originalEnv;
  return module;
}

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('writes JSON logs and redacts sensitive metadata', async () => {
    const { createLogger } = await loadLogger('debug');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    createLogger('test').info('message', {
      apiKey: 'secret',
      nested: { token: 'hidden', visible: 'ok' },
    });

    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ level: 'info', scope: 'test', message: 'message' });
    expect(entry.meta.apiKey).toBe('[REDACTED]');
    expect(entry.meta.nested.token).toBe('[REDACTED]');
    expect(entry.meta.nested.visible).toBe('ok');
  });

  it('honors configured log levels', async () => {
    const { createLogger } = await loadLogger('warn');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const logger = createLogger('test');
    logger.info('skip');
    logger.warn('keep');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('adds request IDs and logs completed HTTP requests', async () => {
    const { requestLogger } = await loadLogger('info');
    const middleware = requestLogger();
    const listeners: Record<string, () => void> = {};
    const req = {
      headers: { 'x-request-id': 'req-1' },
      method: 'GET',
      originalUrl: '/api/health',
      ip: '127.0.0.1',
    } as any;
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        listeners[event] = listener;
      }),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);
    listeners.finish();

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'req-1');
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    expect(next).toHaveBeenCalled();
  });
});
