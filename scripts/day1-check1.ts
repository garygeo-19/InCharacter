/**
 * Day-1 check 1 (REQUIREMENTS.md §12 M0): Muse Spark structured output
 * with a schema containing an enum, per §9.1 + Appendix B.
 *
 * Uses Chat Completions `response_format: { type: "json_schema", ... strict: true }`
 * with the OpenAI SDK pointed at https://api.meta.ai/v1 (docs: /docs/structured-output).
 * Reads MODEL_API_KEY from .dev.vars; never prints it.
 *
 * Run: npm run check:day1
 */
import { chatStructured, createMetaClient } from '../src/server/meta';
import { loadEnv, requireModelApiKey } from '../src/server/env';

// Verdict enum mirrors the grading verdicts in Appendix B.2.
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['covered', 'partial', 'missed', 'wrong'] },
    reason: { type: 'string' },
  },
} as const;

type Day1Result = { verdict: 'covered' | 'partial' | 'missed' | 'wrong'; reason: string };

async function main() {
  const env = loadEnv();
  const client = createMetaClient(requireModelApiKey(env));

  const result = await chatStructured<Day1Result>({
    client,
    model: 'muse-spark-1.3',
    system:
      'You grade a short class against one note. Reply only with the structured verdict.',
    user: [
      'Note: La propina means the tip.',
      'Teacher said: "And la propina — that is the tip you leave at the end."',
      'Give the verdict for this note.',
    ].join('\n'),
    schemaName: 'Day1Check',
    schema: schema as unknown as Record<string, unknown>,
    reasoningEffort: 'low',
  });

  // Validate the enum came back as constrained (no key material here).
  const allowed = ['covered', 'partial', 'missed', 'wrong'];
  if (!allowed.includes(result.verdict) || typeof result.reason !== 'string') {
    throw new Error(`Structured output did not match schema: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify({ ok: true, model: 'muse-spark-1.3', result }, null, 2));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Surface status only; never the key or request headers.
  const status = (err as { status?: number })?.status;
  console.error(JSON.stringify({ ok: false, status: status ?? null, error: message }));
  process.exit(1);
});
