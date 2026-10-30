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

Not yet built (later milestones): voice, art and hosting.

## M1 — Text simulation, Type mode (§12)

Done 30 Oct 2026, Type mode only. Flow: Home (live catalog, Keep teaching) → pack → class list → briefing → 3-2-1 → class (6:00 Type) → "Hands are going up…" (pick + class grade in parallel) → 3 questions (2:00 answers, outline drawer with peek) → grading → debrief with evidence quotes and score. History and best scores stay on the device.

| Check | Result |
|---|---|
| Notes/outline builder (§6) | Unit test reproduces the §6.5 table and anchors exactly from a pack extract; a second test re-checks against the live pack (skips without network) |
| Seed bank (§7.7) | `content/banks/spanish-food-shopping/p10-at-the-restaurant.json`, 12 checked questions, passes all §7.5 code checks |
| Picking (§9.2) | Model choice validated (3 ids, difficulties 1-2-3, no shared notes, not recently asked), rules fallback probes skipped notes; 6 s timeout |
| Grading + evidence (§8.5, §9.3, §9.4) | Every verdict quote-checked in code; fabricated quotes downgrade (covered/partial→missed, wrong→missed, moves/contradictions dropped) |
| Scoring (§8) | §8.7 worked example gives exactly 72 ★★; Appendix C lesson scores 50 / 22.67 / 9.33 / 5.33 |
| Fixtures end to end | `tests/eval-mock.test.ts`: all four classes grade to their labels with zero downgrades; injection first line changes nothing |
| E2E (mocked) | `tests/e2e/flow.spec.ts` (390 × 844, `?fast=1`): Home → debrief scores 63, Keep teaching records Best 63 — written, needs a browser to run (none in this sandbox) |
| Live eval | `npm run eval` hits the dev API with the fixtures — deferred to M5 (spends key budget) |

## M2 — Question banks (§12)

Done 30 Oct 2026: all 3 parts ready. `bank:build` (writer → code-made ids → code checks → checker → select), `bank:review` and `bank:approve` exist; the M2 checker test slips the four §7.1 ✗ questions into a draft and uses recorded B.5 verdicts, so it never spends credits. A code-ids unit test pins the root-cause fix (bad writer id → valid code-made id).

| Part | Notes | Kept | Ready |
|---|---|---|---|
| p10 At the Restaurant | 10 | 12 checked (d1: 3, d2: 4, d3: 5) | Yes — verified fresh (hashes match live v1.0.9), not rebuilt |
| p11 Common Foods | 11 | 13 checked (d1: 7, d2: 3, d3: 3) | Yes — rebuilt live once after the fix; code checks rejected 0, checker rejected 0 |
| p12 Drinks and Sweets | 11 | 13 checked (d1: 7, d2: 3, d3: 3) | Yes — rebuilt live once after the fix; code checks rejected 0, checker rejected 1 |

Live spend: first p11/p12 builds ≈ $0.117 total (writer only; checker had nothing to check; files superseded). Rebuilds after the fix: p11 ≈ $0.196, p12 ≈ $0.229. M2 live total ≈ $0.542. Each part was rebuilt exactly once with owner approval; kept questions stay `checked` (human review/approval is later).

## Decisions

Choices made where the spec is silent, one line each with its date.

- 29 Oct 2026 — Day-1 checks 2–5 are deferred to the milestones that need them: voice (check 2) before M3, art (check 3) before M4, ElevenLabs voices (check 4) before M3, hosting/9 MB upload (check 5) before M5. Only check 1 was run for M0, to keep the two-days-behind schedule lean.
- 29 Oct 2026 — Dev runs Hono on Node (`@hono/node-server`, port 8787) behind the Vite proxy; the same Hono app deploys to Cloudflare Workers in M5, so no server rewrite is expected.
- 29 Oct 2026 — `npm run dev` binds Vite to `0.0.0.0` so a phone on the same Wi-Fi can reach it, and the API to `127.0.0.1` only (the phone reaches it through Vite's proxy); production CORS stays limited to `APP_ORIGIN` (§10.4).
- 30 Oct 2026 — Evidence words exclude a fixed English/Spanish function-word list (`src/shared/notes.ts`); the spec's list is open-ended ("and so on").
- 30 Oct 2026 — Rate limit is 36 class-op calls/hour/IP (≈ 12 classes: pick + 2 grades each); transcriptions get their own counter in M3.
- 30 Oct 2026 — M1 is Type-only: the Voice button is disabled, questions show captions only (no Replay) until M3 records audio.
- 30 Oct 2026 — The client reads catalog/packs through `/api` (the server caches packs by `id@version`); note hashes use a dependency-free SHA-256 so the same module runs in the browser.
- 30 Oct 2026 — `?fast=1` shortens timers (class 12 s, answers 8 s) for the mocked E2E and demos; real play uses the §8 config values.
- 30 Oct 2026 — Model-call effects fire once via refs, so React StrictMode's dev double-mount can't double-spend.
- 30 Oct 2026 — M2 live builds: all 52 drafts for p11/p12 were rejected solely for id shape (`q01…`, `maya-1…` instead of `q-` slugs). The A.4 writer prompt never stated the id format and the B.4 schema leaves `id` a free string, so the model invented ids.
- 30 Oct 2026 — M2 root-cause fix (applied): question ids no longer depend on the writer. `bank:build` assigns every draft a code-made id (`q-` plus a slug of its text, de-duplicated, in `assignQuestionIds`) before the code checks, so a bad writer id is repaired, never a rejection. The A.4 writer prompt now also states the id format (a one-line addition to the spec-verbatim prompt, since spec Appendix A omits it). The p11/p12 zero-kept files were superseded by one approved live rebuild each.
