# In Character

**Role-play what you learn.** You study a lesson's notes, teach a 3-minute class to four AI students, answer three of
their questions, and get a score backed by your own words.

In Character is a mobile-first web app for the Meta Global AI Developer Hackathon (27 Oct – 4 Nov 2026), built with
Muse Code on Meta's Model API. Its lessons come from [FlashFeed](https://flashfeedlearningapp.com)'s public knowledge
packs, read at run time.

- [REQUIREMENTS.md](REQUIREMENTS.md) is the build spec.
- [AGENTS.md](AGENTS.md) holds the standing rules for coding agents.

## Run it

```bash
npm install
npm run dev        # client + API together
npm test           # unit tests (Vitest)
npm run check:day1 # Day-1 check 1 (needs MODEL_API_KEY in .dev.vars)
```

- Laptop: http://localhost:5173/
- Phone (same Wi-Fi): use the `Network:` URL that Vite prints when it starts.
- API health: http://localhost:5173/api/health (proxied to the Hono server on :8787)

Stack (§10.3): TypeScript, React + Vite, Hono (Node in dev, Workers-ready), Zod, OpenAI SDK against Meta's base URL, Vitest, Playwright (config scaffolded; the mobile test lands in M1). Layout follows §10.5. CI (`.github/workflows/ci.yml`) runs typecheck, unit tests and build on push/PR.

## M0 — Setup and day-1 checks (§12)

| Check | Result |
|---|---|
| Repo scaffold (§10.3 stack, §10.5 layout) | Done 29 Oct 2026 |
| `npm run dev` on laptop + phone over Wi-Fi | Passed 29 Oct 2026: page 200 at `localhost:5173` and at the LAN URL above; `/api/health` returned `{ "ok": true }` direct and via the Vite proxy |
| CI runs the unit tests | Done 29 Oct 2026: workflow runs `npm ci`, typecheck, `npm test`, build. Locally: 3 Vitest tests pass, typecheck clean, production build succeeds |
| Day-1 check 1: Muse Spark structured output with an enum | Passed 29 Oct 2026: `muse-spark-1.3`, Chat Completions `response_format` json_schema with `strict: true` (§9.1, structured-output docs), schema `Day1Check` with `verdict` enum `covered\|partial\|missed\|wrong`. Returned `{ verdict: "covered", reason: "Teacher explicitly stated la propina is the tip…" }` — valid against the schema. Re-run with `npm run check:day1`. Key read from `.dev.vars`, never printed or logged |
| Day-1 checks 2–5 | Deferred — see Decisions |

Not yet built (later milestones): the M1 text simulation, banks, voice, art and hosting. The home page is an M0 placeholder that only proves the stack and the `/api/health` wiring.

## Decisions

Choices made where the spec is silent, one line each with its date.

- 29 Oct 2026 — Day-1 checks 2–5 are deferred to the milestones that need them: voice (check 2) before M3, art (check 3) before M4, ElevenLabs voices (check 4) before M3, hosting/9 MB upload (check 5) before M5. Only check 1 was run for M0, to keep the two-days-behind schedule lean.
- 29 Oct 2026 — Dev runs Hono on Node (`@hono/node-server`, port 8787) behind the Vite proxy; the same Hono app deploys to Cloudflare Workers in M5, so no server rewrite is expected.
- 29 Oct 2026 — `npm run dev` binds Vite to `0.0.0.0` so a phone on the same Wi-Fi can reach it, and the API to `127.0.0.1` only (the phone reaches it through Vite's proxy); production CORS stays limited to `APP_ORIGIN` (§10.4).
