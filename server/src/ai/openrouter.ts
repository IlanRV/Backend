import type { ZodType } from 'zod';
import { config } from '../config';
import { createLogger } from '../lib/logger';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
const DEFAULT_TRANSIENT_COOLDOWN_MS = 7_500;
const MAX_RETRY_DELAY_MS = 3_000;

const logger = createLogger('openrouter');

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | object;
      role?: string;
    };
  }>;
}

interface OpenRouterErrorDetails {
  message?: string;
  code?: number | string;
  providerName?: string;
  rawProviderMessage?: string;
}

export interface OpenRouterCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

interface CompletionRequestOptions extends OpenRouterCallOptions {
  responseFormat?: object;
}

const modelCooldownUntil = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function getCandidateModels(options?: OpenRouterCallOptions): string[] {
  return uniqueModels([options?.model || config.openrouter.model, ...config.openrouter.fallbackModels]);
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');

  if (!header) {
    return undefined;
  }

  const seconds = Number.parseInt(header, 10);

  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function parseOpenRouterErrorDetails(responseBody: string): OpenRouterErrorDetails {
  try {
    const parsed = JSON.parse(responseBody) as unknown;

    if (!isRecord(parsed) || !isRecord(parsed.error)) {
      return {};
    }

    const metadata = isRecord(parsed.error.metadata) ? parsed.error.metadata : {};

    return {
      message: typeof parsed.error.message === 'string' ? parsed.error.message : undefined,
      code:
        typeof parsed.error.code === 'string' || typeof parsed.error.code === 'number'
          ? parsed.error.code
          : undefined,
      providerName: typeof metadata.provider_name === 'string' ? metadata.provider_name : undefined,
      rawProviderMessage: typeof metadata.raw === 'string' ? metadata.raw : undefined,
    };
  } catch {
    return {};
  }
}

function formatStatusMessage(statusCode: number, details: OpenRouterErrorDetails, responseBody: string): string {
  if (details.message) {
    return details.message;
  }

  if (responseBody.trim().length > 0) {
    return responseBody.slice(0, 500);
  }

  return statusCode === 0 ? 'Network request failed' : 'No error body returned';
}

export class OpenRouterConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterConfigurationError';
  }
}

export class OpenRouterError extends Error {
  public readonly code?: number | string;
  public readonly providerName?: string;
  public readonly rawProviderMessage?: string;

  constructor(
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly model: string,
    public readonly retryAfterMs?: number
  ) {
    const details = parseOpenRouterErrorDetails(responseBody);
    super(`OpenRouter API error ${statusCode} for ${model}: ${formatStatusMessage(statusCode, details, responseBody)}`);
    this.name = 'OpenRouterError';
    this.code = details.code;
    this.providerName = details.providerName;
    this.rawProviderMessage = details.rawProviderMessage;
  }

  get isRateLimited(): boolean {
    return this.statusCode === 429 || this.code === 429 || this.code === '429';
  }

  get isTransient(): boolean {
    return this.statusCode === 0 || this.statusCode === 408 || this.statusCode === 429 || this.statusCode >= 500;
  }
}

function createHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.openrouter.apiKey}`,
    'Content-Type': 'application/json',
    ...(config.openrouter.siteUrl ? { 'HTTP-Referer': config.openrouter.siteUrl } : {}),
    ...(config.openrouter.appName ? { 'X-Title': config.openrouter.appName } : {}),
  };
}

function createTimeoutSignal(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.openrouter.timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function buildBody(
  userMessage: string,
  systemPrompt: string,
  model: string,
  options?: CompletionRequestOptions
): object {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: options?.maxTokens || config.openrouter.maxTokens,
    temperature: options?.temperature ?? 0.2,
    ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
  };
}

function assertOpenRouterConfigured(): void {
  if (!config.openrouter.apiKey) {
    logger.warn('openrouter_missing_api_key');
    throw new OpenRouterConfigurationError('OpenRouter API key is not configured. Set OPENROUTER_API_KEY in server/.env.');
  }
}

function getAvailableModels(candidates: string[]): string[] {
  const now = Date.now();
  const availableModels = candidates.filter((model) => (modelCooldownUntil.get(model) || 0) <= now);

  if (availableModels.length > 0) {
    return availableModels;
  }

  const nextAvailableAt = Math.min(...candidates.map((model) => modelCooldownUntil.get(model) || now));
  const retryAfterMs = Math.max(0, nextAvailableAt - now);
  throw new OpenRouterError(
    429,
    JSON.stringify({ error: { message: `All configured OpenRouter models are cooling down for ${retryAfterMs}ms.` } }),
    candidates.join(', '),
    retryAfterMs
  );
}

function markModelCooldown(model: string, error: OpenRouterError): void {
  if (!error.isTransient) {
    return;
  }

  const cooldownMs = error.isRateLimited
    ? error.retryAfterMs || DEFAULT_RATE_LIMIT_COOLDOWN_MS
    : DEFAULT_TRANSIENT_COOLDOWN_MS;
  modelCooldownUntil.set(model, Date.now() + cooldownMs);
}

function retryDelay(error: OpenRouterError, attemptIndex: number): number {
  if (error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, MAX_RETRY_DELAY_MS);
  }

  return Math.min(500 * 2 ** attemptIndex, MAX_RETRY_DELAY_MS);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponse(response: Response, model: string): Promise<string> {
  if (!response.ok) {
    const errorBody = await response.text();
    logger.warn('openrouter_response_error', {
      model,
      status: response.status,
      bodyPreview: errorBody.slice(0, 500),
    });
    throw new OpenRouterError(response.status, errorBody, model, parseRetryAfter(response));
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    logger.warn('openrouter_missing_content', { model });
    throw new Error('OpenRouter API response did not include assistant content.');
  }

  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function postCompletion(
  userMessage: string,
  systemPrompt: string,
  model: string,
  options?: CompletionRequestOptions
): Promise<string> {
  const { signal, clear } = createTimeoutSignal();

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: createHeaders(),
      signal,
      body: JSON.stringify(buildBody(userMessage, systemPrompt, model, options)),
    });
    const content = await parseResponse(response, model);
    return content;
  } catch (error) {
    if (error instanceof OpenRouterError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Unknown network error';
    throw new OpenRouterError(0, JSON.stringify({ error: { message } }), model);
  } finally {
    clear();
  }
}

async function requestWithFallback(
  userMessage: string,
  systemPrompt: string,
  options?: CompletionRequestOptions
): Promise<string> {
  assertOpenRouterConfigured();

  const candidates = getCandidateModels(options);
  const availableModels = getAvailableModels(candidates);
  let lastError: unknown;

  for (const model of availableModels) {
    for (let attemptIndex = 0; attemptIndex <= config.openrouter.retryCount; attemptIndex += 1) {
      try {
        return await postCompletion(userMessage, systemPrompt, model, options);
      } catch (error) {
        lastError = error;

        if (!(error instanceof OpenRouterError)) {
          throw error;
        }

        const hasFallbackModel = availableModels.length > 1;
        const shouldRetrySameModel =
          error.isTransient &&
          attemptIndex < config.openrouter.retryCount &&
          (!error.isRateLimited || !hasFallbackModel);

        if (!shouldRetrySameModel) {
          markModelCooldown(model, error);
          break;
        }

        await wait(retryDelay(error, attemptIndex));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('OpenRouter request failed.');
}

export async function callOpenRouter(
  userMessage: string,
  systemPrompt: string,
  optionsOrModel?: string | OpenRouterCallOptions
): Promise<string> {
  const options = typeof optionsOrModel === 'string' ? { model: optionsOrModel } : optionsOrModel;
  return requestWithFallback(userMessage, systemPrompt, options);
}

export async function callOpenRouterStructured<T>(
  userMessage: string,
  systemPrompt: string,
  jsonSchema: object,
  responseSchema?: ZodType<T>,
  options?: OpenRouterCallOptions
): Promise<T> {
  const responseFormat = config.openrouter.strictJsonSchema
    ? {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: jsonSchema,
          strict: true,
        },
      }
    : undefined;
  const baseSystemPrompt = config.openrouter.strictJsonSchema ? systemPrompt : buildJsonOnlySystemPrompt(systemPrompt);
  let callOptions: CompletionRequestOptions = {
    ...options,
    temperature: options?.temperature ?? 0.1,
    ...(responseFormat ? { responseFormat } : {}),
  };
  let content: string;

  try {
    content = await requestWithFallback(userMessage, baseSystemPrompt, callOptions);
  } catch (error) {
    if (!config.openrouter.strictJsonSchema || !isStructuredFormatUnsupported(error)) {
      throw error;
    }

    logger.warn('openrouter_structured_response_format_unsupported');
    callOptions = { ...options, temperature: options?.temperature ?? 0.1 };
    content = await requestWithFallback(userMessage, buildJsonOnlySystemPrompt(systemPrompt), callOptions);
  }

  try {
    return parseStructuredContent(content, responseSchema);
  } catch (error) {
    logger.warn('openrouter_structured_validation_failed_retrying', {
      error: error instanceof Error ? error.message : 'Unknown structured response error',
      responseLength: content.length,
    });
  }

  const retryContent = await requestWithFallback(
    userMessage,
    buildJsonOnlySystemPrompt(systemPrompt),
    callOptions
  );

  return parseStructuredContent(retryContent, responseSchema);
}

function buildJsonOnlySystemPrompt(systemPrompt: string): string {
  return `${systemPrompt}\n\nCRITICAL: Respond with valid JSON only. Match the schema exactly. Do not include markdown, code fences, prose, comments, or trailing commas.`;
}

function isStructuredFormatUnsupported(error: unknown): boolean {
  if (!(error instanceof OpenRouterError) || error.statusCode !== 400) {
    return false;
  }

  return /response_format|json_schema|structured|schema/i.test(`${error.message}\n${error.responseBody}`);
}

function stripJsonFence(content: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(content.trim());
  return match?.[1]?.trim() || content.trim();
}

function parseStructuredContent<T>(content: string, responseSchema?: ZodType<T>): T {
  const parsed = JSON.parse(stripJsonFence(content)) as unknown;
  return responseSchema ? responseSchema.parse(parsed) : (parsed as T);
}

export function isOpenRouterFailure(error: unknown): boolean {
  return error instanceof OpenRouterError || error instanceof OpenRouterConfigurationError;
}

export function formatOpenRouterFailure(error: unknown): string {
  if (error instanceof OpenRouterConfigurationError) {
    return error.message;
  }

  if (!(error instanceof OpenRouterError)) {
    return error instanceof Error ? error.message : 'Unknown AI provider error.';
  }

  const providerText = error.providerName ? ` from ${error.providerName}` : '';
  const retryText = error.retryAfterMs ? ` Retry after about ${Math.ceil(error.retryAfterMs / 1000)}s.` : '';
  const rawText = error.rawProviderMessage ? ` Provider detail: ${error.rawProviderMessage}` : '';

  if (error.isRateLimited) {
    return `OpenRouter model ${error.model} is rate-limited${providerText}.${retryText}${rawText}`.trim();
  }

  if (error.statusCode === 0) {
    return `OpenRouter request timed out or could not connect for model ${error.model}.${retryText}`.trim();
  }

  return `OpenRouter request failed with status ${error.statusCode} for model ${error.model}.${retryText}${rawText}`.trim();
}
