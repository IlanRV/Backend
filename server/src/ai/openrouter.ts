import { config } from '../config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
    throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY in server/.env.');
  }
}

async function parseResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
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

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || config.openrouter.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 4096,
    }),
  });

  return parseResponse(response);
}

export async function callOpenRouterStructured<T>(
  userMessage: string,
  systemPrompt: string,
  jsonSchema: object
): Promise<T> {
  assertOpenRouterConfigured();

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
    return JSON.parse(content) as T;
  } catch {
    console.warn('OpenRouter structured response was not valid JSON. Retrying once.');
  }

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

  return JSON.parse(await parseResponse(retryResponse)) as T;
}