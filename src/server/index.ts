import { writeFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadEnv } from './env';

const env = loadEnv();
const port = Number(env.PORT ?? 8787);

// Bound to loopback only: the phone reaches the API through Vite's proxy,
// so nothing else on the Wi-Fi can call a server that holds the key.
serve(
  {
    fetch: createApp(env, {
      // Debug hook only: with SAVE_FAILED_WAV set, a WAV that Meta rejects
      // is written to that path for inspection. Never set in production.
      ...(env.SAVE_FAILED_WAV
        ? { saveFailedWav: (wav: Uint8Array) => writeFileSync(env.SAVE_FAILED_WAV as string, wav) }
        : {}),
    }).fetch,
    port,
    hostname: '127.0.0.1',
  },
  (info) => {
    console.log(`API listening on http://localhost:${info.port}`);
  },
);
