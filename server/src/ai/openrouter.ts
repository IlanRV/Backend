import { config } from '../config';
import { createLogger } from '../lib/logger';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const logger = createLogger('openrouter');

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
      role?: string;
    };
  }>;
}

function structuredBody(userMessage: string, systemPrompt: string, jsonSchema: object): object {
  return {
    model: config.openrouter.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 4096,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: jsonSchema,
        strict: true,
      },
    },
  };
}

function assertOpenRouterConfigured(): void {
  if (!config.openrouter.apiKey) {
    logger.warn('openrouter_missing_api_key');
    throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY in server/.env.');
  }
}

async function parseResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const errorBody = await response.text();
    logger.warn('openrouter_response_error', {
      status: response.status,
      bodyPreview: errorBody.slice(0, 500),
    });
    throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    logger.warn('openrouter_missing_content');
    throw new Error('OpenRouter API response did not include assistant content.');
  }

  return content;
}

export async function callOpenRouter(
  userMessage: string,
  systemPrompt: string,
  model?: string
): Promise<string> {
  assertOpenRouterConfigured();
  const startedAt = Date.now();
  const selectedModel = model || config.openrouter.model;

  logger.info('openrouter_call_started', {
    model: selectedModel,
    mode: 'text',
    userMessageLength: userMessage.length,
    systemPromptLength: systemPrompt.length,
  });

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 4096,
    }),
  });

  const content = await parseResponse(response);
  logger.info('openrouter_call_completed', {
    model: selectedModel,
    mode: 'text',
    durationMs: Date.now() - startedAt,
    responseLength: content.length,
  });
  return content;
}

export async function callOpenRouterStructured<T>(
  userMessage: string,
  systemPrompt: string,
  jsonSchema: object
): Promise<T> {
  assertOpenRouterConfigured();
  const startedAt = Date.now();

  logger.info('openrouter_call_started', {
    model: config.openrouter.model,
    mode: 'structured',
    userMessageLength: userMessage.length,
    systemPromptLength: systemPrompt.length,
  });

  const headers = {
    Authorization: `Bearer ${config.openrouter.apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(structuredBody(userMessage, systemPrompt, jsonSchema)),
  });

  const content = await parseResponse(response);

  try {
    const parsed = JSON.parse(content) as T;
    logger.info('openrouter_call_completed', {
      model: config.openrouter.model,
      mode: 'structured',
      durationMs: Date.now() - startedAt,
      responseLength: content.length,
      retried: false,
    });
    return parsed;
  } catch {
    logger.warn('openrouter_structured_json_parse_failed_retrying', {
      responseLength: content.length,
    });
  }

  const retryStartedAt = Date.now();
  const retryResponse = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      structuredBody(
        userMessage,
        `${systemPrompt}\n\nCRITICAL: Respond with valid JSON only. Do not include markdown, code fences, prose, or comments.`,
        jsonSchema
      )
    ),
  });

  const retryContent = await parseResponse(retryResponse);
  const parsed = JSON.parse(retryContent) as T;
  logger.info('openrouter_call_completed', {
    model: config.openrouter.model,
    mode: 'structured',
    durationMs: Date.now() - startedAt,
    retryDurationMs: Date.now() - retryStartedAt,
    responseLength: retryContent.length,
    retried: true,
  });
  return parsed;
}
