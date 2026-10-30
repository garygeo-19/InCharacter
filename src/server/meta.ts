import OpenAI from 'openai';

// Meta Model API via the OpenAI SDK (REQUIREMENTS.md §9.1).
// Chat Completions structured output: response_format json_schema, strict.
// See https://dev.meta.ai/docs/structured-output
export function createMetaClient(apiKey: string): OpenAI {
  return new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey });
}

export type JsonSchema = Record<string, unknown>;

function isRetryable(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500);
}

// One retry with backoff + jitter on 429/5xx, honoring Retry-After (§9.1).
export async function chatStructured<T>(opts: {
  client: OpenAI;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: JsonSchema;
  reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<T> {
  const { client, model, system, user, schemaName, schema, reasoningEffort } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, schema, strict: true },
        },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      };
      const res = await client.chat.completions.create(params);
      const content = res.choices[0]?.message?.content;
      if (!content) throw new Error('Model returned no content');
      return JSON.parse(content) as T;
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number })?.status;
      if (attempt === 1 || !isRetryable(status)) throw err;
      const retryAfter = (err as { headers?: Record<string, string> })?.headers?.['retry-after'];
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 500 + Math.random() * 500;
      await new Promise((r) => setTimeout(r, Number.isFinite(waitMs) ? waitMs : 500));
    }
  }
  throw lastError;
}
