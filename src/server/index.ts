import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadEnv } from './env';

const env = loadEnv();
const port = Number(env.PORT ?? 8787);

// Bound to loopback only: the phone reaches the API through Vite's proxy,
// so nothing else on the Wi-Fi can call a server that holds the key.
serve({ fetch: createApp(env).fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
