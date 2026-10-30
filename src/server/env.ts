import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Local secrets live in .dev.vars (Wrangler convention, gitignored) or the
// process environment. Values are never logged.
export function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = readFileSync(resolve(process.cwd(), '.dev.vars'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No .dev.vars; fall back to process.env only.
  }
  return { ...env, ...process.env } as Record<string, string>;
}

export function requireModelApiKey(env: Record<string, string>): string {
  const key = env.MODEL_API_KEY;
  if (!key) throw new Error('MODEL_API_KEY is not set (expected in .dev.vars)');
  return key;
}
