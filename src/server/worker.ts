// Cloudflare Workers entry. Serves the same Hono app as the Node dev server
// (`src/server/index.ts`), built from the Worker env bindings. Static assets
// (the Vite build in dist/) are served by the Workers Assets binding in
// wrangler.jsonc; this Worker handles /api/*, with SPA fallback configured
// there. This module must not import node: builtins or touch process.env —
// everything the app needs arrives in `env`.
//
// Bank files: Workers have no filesystem, so the approved banks are bundled
// as JSON imports and registered with setBankFiles(). When a new part is
// banked, add its import and map entry here before redeploying.

import { createApp } from './app';
import { setBankFiles, setSessionFiles } from './content';
import p10 from '../../content/banks/spanish-food-shopping/p10-at-the-restaurant.json';
import p11 from '../../content/banks/spanish-food-shopping/p11-common-foods.json';
import p12 from '../../content/banks/spanish-food-shopping/p12-drinks-sweets.json';

setBankFiles({
  'spanish-food-shopping/p10-at-the-restaurant': p10,
  'spanish-food-shopping/p11-common-foods': p11,
  'spanish-food-shopping/p12-drinks-sweets': p12,
});

// No approved sessions ship yet (the reviewer runs session:build live);
// register each new content/sessions/{packId}/{partId}.json here on deploy.
setSessionFiles({});

type Env = {
  MODEL_API_KEY: string;
  CATALOG_BASE?: string;
  APP_ORIGIN?: string;
  DAILY_CALL_CAP?: string;
  USABLE_STATUSES?: string;
};

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const app = createApp(env as unknown as Record<string, string>);
    return app.fetch(request);
  },
};
