import { afterEach, describe, expect, it, vi } from 'vitest';

const baseConfig = {
  openrouter: {
    apiKey: '',
    model: 'deepseek/deepseek-v4-flash',
    fallbackModels: [] as string[],
    maxTokens: 512,
    retryCount: 0,
    timeoutMs: 1000,
    strictJsonSchema: true,
    siteUrl: '',
    appName: 'DevHub',
  },
};

async function loadOpenRouter(config = baseConfig) {
  vi.resetModules();
  vi.doMock('../../src/config', () => ({ config }));
  vi.doMock('../../src/lib/logger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }));
  return import('../../src/ai/openrouter');
}

describe('OpenRouter client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('../../src/config');
    vi.doUnmock('../../src/lib/logger');
  });

  it('throws a configuration error when no API key is set', async () => {
    const openrouter = await loadOpenRouter();

    await expect(openrouter.callOpenRouter('hello', 'system')).rejects.toThrow(openrouter.OpenRouterConfigurationError);
  });

  it('formats provider failures for user-facing fallback text', async () => {
    const openrouter = await loadOpenRouter();
    const error = new openrouter.OpenRouterError(
      429,
      JSON.stringify({
        error: {
          message: 'Rate limited',
          code: 429,
          metadata: { provider_name: 'DeepSeek', raw: 'Too many requests' },
        },
      }),
      'deepseek/deepseek-v4-flash',
      2000
    );

    expect(openrouter.isOpenRouterFailure(error)).toBe(true);
    expect(openrouter.formatOpenRouterFailure(error)).toContain('rate-limited');
    expect(openrouter.formatOpenRouterFailure(error)).toContain('DeepSeek');
  });

  it('parses structured JSON responses and validates them with zod', async () => {
    const config = {
      ...baseConfig,
      openrouter: { ...baseConfig.openrouter, apiKey: 'test-key' },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"reply":"hello"}' } }] }),
      headers: new Headers(),
    });
    vi.stubGlobal('fetch', fetchMock);

    const openrouter = await loadOpenRouter(config);
    const { z } = await import('zod');
    const result = await openrouter.callOpenRouterStructured(
      'user',
      'system',
      {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
        additionalProperties: false,
      },
      z.object({ reply: z.string() })
    );

    expect(result).toEqual({ reply: 'hello' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('openrouter.ai'),
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
    );
  });

  it('falls back to JSON-only prompting when structured response format is unsupported', async () => {
    const config = {
      ...baseConfig,
      openrouter: { ...baseConfig.openrouter, apiKey: 'test-key', strictJsonSchema: true },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'response_format unsupported' } }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '```json\n{"reply":"ok"}\n```' } }] }),
        headers: new Headers(),
      });
    vi.stubGlobal('fetch', fetchMock);

    const openrouter = await loadOpenRouter(config);
    const result = await openrouter.callOpenRouterStructured('user', 'system', { type: 'object' });

    expect(result).toEqual({ reply: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
