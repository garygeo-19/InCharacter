import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Hono app (REQUIREMENTS.md §10.2/§10.3). Runs on Node in dev and on
// Cloudflare Workers when deployed (M5). Prompts are built here; the
// client never sends one.
export function createApp(env: Record<string, string>) {
  const app = new Hono();
  const origin = env.APP_ORIGIN ?? 'http://localhost:5173';
  app.use('/api/*', cors({ origin: [origin, 'http://localhost:5173'] }));

  app.get('/api/health', (c) => c.json({ ok: true }));

  return app;
}
