// Pure server env helpers: no node: imports, so this module bundles cleanly
// for Cloudflare Workers. Node-only loading (.dev.vars, process.env) stays
// in ./env, which re-exports requireModelApiKey from here.
export function requireModelApiKey(env: Record<string, string>): string {
  const key = env.MODEL_API_KEY;
  if (!key) throw new Error('MODEL_API_KEY is not set (expected in .dev.vars)');
  return key;
}
