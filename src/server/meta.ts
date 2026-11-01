import OpenAI from 'openai';

// Meta Model API via the OpenAI SDK (REQUIREMENTS.md §9.1).
// Chat Completions structured output: response_format json_schema, strict.
// See https://dev.meta.ai/docs/structured-output
export function createMetaClient(apiKey: string, fetchImpl?: typeof fetch): OpenAI {
  // fetchImpl is dependency injection for tests: the server passes its
  // request fetch through createApp opts, so unit tests can answer model
  // calls without touching the network or the SDK's internals.
  return new OpenAI({
    baseURL: 'https://api.meta.ai/v1',
    apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

export type JsonSchema = Record<string, unknown>;

/** Token counts from one Chat Completions call, for cost reporting. */
export type TokenUsage = {
  input: number;
  output: number;
  total: number;
  reasoning?: number;
};

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
  // Effort levels per the reasoning docs; "max" is supported by
  // muse-wonder-1.0 and muse-spark-1.3 (not the contributor variants).
  // See https://dev.meta.ai/docs/reasoning
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  // Reasoning tokens share the output budget, so bank calls pass a generous
  // maxTokens. See https://dev.meta.ai/docs/reasoning ("Token usage").
  maxTokens?: number;
  onUsage?: (u: TokenUsage) => void;
}): Promise<T> {
  const { client, model, system, user, schemaName, schema, reasoningEffort, maxTokens, onUsage } = opts;
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
        // Cast: the API accepts "max" (see reasoning docs) but the SDK's
        // ReasoningEffort type lags behind; the string passes through as-is.
        ...(reasoningEffort
          ? {
              reasoning_effort: reasoningEffort as NonNullable<
                OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['reasoning_effort']
              >,
            }
          : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      };
      const res = await client.chat.completions.create(params);
      const usage = res.usage;
      if (usage && onUsage) {
        try {
          onUsage({
            input: usage.prompt_tokens ?? 0,
            output: usage.completion_tokens ?? 0,
            total: usage.total_tokens ?? 0,
            reasoning: usage.completion_tokens_details?.reasoning_tokens ?? undefined,
          });
        } catch {
          // Reporting must never break the call.
        }
      }
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
