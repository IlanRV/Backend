import dotenv from 'dotenv';

dotenv.config();

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readDeepSeekModel(value: string | undefined): string {
  const model = value?.trim();
  return model?.startsWith('deepseek/') ? model : 'deepseek/deepseek-v4-flash';
}

const openrouterModel = readDeepSeekModel(process.env.OPENROUTER_MODEL);

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  corsOrigins: [
    process.env.CORS_ORIGIN || 'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ],
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '')
      .replace(/^"|"$/g, '')   // strip surrounding quotes (dotenv strips them, raw env vars may not)
      .replace(/\\n/g, '\n')   // convert literal \n to real newlines (for .env file format)
      .trim(),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: openrouterModel,
    fallbackModels: parseCsv(process.env.OPENROUTER_FALLBACK_MODELS || process.env.OPENROUTER_MODEL_FALLBACKS).filter(
      (model) => model !== openrouterModel && model.startsWith('deepseek/')
    ),
    maxTokens: parseInteger(process.env.OPENROUTER_MAX_TOKENS, 4096),
    retryCount: parseInteger(process.env.OPENROUTER_RETRY_COUNT, 0),
    timeoutMs: parseInteger(process.env.OPENROUTER_TIMEOUT_MS, 45000),
    strictJsonSchema: parseBoolean(process.env.OPENROUTER_STRICT_JSON_SCHEMA, true),
    appName: process.env.OPENROUTER_APP_NAME || 'DevHub',
    siteUrl: process.env.OPENROUTER_SITE_URL || '',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};
