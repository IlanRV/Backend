import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  const originalEnv = { ...process.env };
  process.env = { ...originalEnv, ...env };
  const module = await import('../src/config');
  process.env = originalEnv;
  return module.config;
}

describe('config', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('uses safe defaults for local development', async () => {
    const config = await loadConfig({
      PORT: undefined,
      CORS_ORIGIN: undefined,
      OPENROUTER_MODEL: undefined,
      OPENROUTER_API_KEY: undefined,
    });

    expect(config.port).toBe(3001);
    expect(config.corsOrigins).toContain('http://localhost:5173');
    expect(config.openrouter.model).toBe('deepseek/deepseek-v4-flash');
    expect(config.openrouter.maxTokens).toBe(4096);
    expect(config.openrouter.strictJsonSchema).toBe(true);
  });

  it('parses OpenRouter tuning values and keeps only DeepSeek fallbacks', async () => {
    const config = await loadConfig({
      PORT: '4000',
      OPENROUTER_MODEL: 'deepseek/deepseek-chat',
      OPENROUTER_FALLBACK_MODELS: 'anthropic/claude, deepseek/deepseek-v4-flash, deepseek/deepseek-chat',
      OPENROUTER_MAX_TOKENS: '2048',
      OPENROUTER_RETRY_COUNT: '2',
      OPENROUTER_TIMEOUT_MS: '5000',
      OPENROUTER_STRICT_JSON_SCHEMA: 'false',
      FIREBASE_PRIVATE_KEY: 'line1\\nline2',
    });

    expect(config.port).toBe(4000);
    expect(config.openrouter.model).toBe('deepseek/deepseek-chat');
    expect(config.openrouter.fallbackModels).toEqual(['deepseek/deepseek-v4-flash']);
    expect(config.openrouter.maxTokens).toBe(2048);
    expect(config.openrouter.retryCount).toBe(2);
    expect(config.openrouter.timeoutMs).toBe(5000);
    expect(config.openrouter.strictJsonSchema).toBe(false);
    expect(config.firebase.privateKey).toBe('line1\nline2');
  });

  it('falls back from invalid integer and model values', async () => {
    const config = await loadConfig({
      OPENROUTER_MODEL: 'anthropic/claude',
      OPENROUTER_MAX_TOKENS: '-1',
      OPENROUTER_RETRY_COUNT: 'abc',
      OPENROUTER_TIMEOUT_MS: 'nope',
    });

    expect(config.openrouter.model).toBe('deepseek/deepseek-v4-flash');
    expect(config.openrouter.maxTokens).toBe(4096);
    expect(config.openrouter.retryCount).toBe(0);
    expect(config.openrouter.timeoutMs).toBe(45000);
  });
});
