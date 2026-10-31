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

## Deploy

In Character deploys as one Cloudflare Worker named `incharacter` (Free plan), built from this repo by
Cloudflare's GitHub integration (Workers Builds). Nobody deploys from a laptop: the owner connects the repo
once in the dashboard, and pushes rebuild and redeploy it. Keys never go in the repo, and deployment is never
done by the coding agent.

Dashboard setup for the owner (one time):

1. Cloudflare dashboard → Workers & Pages → Create → Import a repository → select this repo.
2. Build settings: Build command `npm ci && npm run build`, Deploy command `npx wrangler deploy`.
   (`wrangler.jsonc`: Worker name `incharacter`, entry `src/server/worker.ts`, static assets from `dist/`
   with SPA fallback, `workers_dev` true.)
3. Settings → Variables and Secrets: keep the non-secret vars from `wrangler.jsonc`
   (`CATALOG_BASE`, `APP_ORIGIN`, `DAILY_CALL_CAP`, `USABLE_STATUSES`), and add `MODEL_API_KEY` as an
   **encrypted secret** — never as a plain variable, never in the repo.
4. Deploy. The first deploy assigns `https://incharacter.<subdomain>.workers.dev`. Copy that URL into the
   `APP_ORIGIN` variable (it ships as a `https://incharacter.<your-subdomain>.workers.dev` placeholder) so
   CORS allows the app; the new value applies to new requests without a redeploy.
5. Optional: attach the real domain under Worker → Settings → Domains.

Local checks that need no login: `npm run typecheck`, `npm test`, `npm run build`, and
`npx wrangler deploy --dry-run --outdir /tmp/wr-dry`. The dry run reports the bundle size (31 Oct 2026:
worker 584,129 B ≈ 570 KiB, ≈ 106 KiB gzip — comfortably under the 1 MiB Free-plan script limit; static
assets upload separately).

Worker notes:

- The Worker serves the same Hono app as the dev server (`src/server/worker.ts` builds it from the env
  bindings). `/api/transcribe` walks the upload as a stream — size from Content-Length plus a byte-counting
  pass, WAV header from the first 44 bytes only — so a multi-MB WAV stays within the 10 ms CPU budget.
  Catalog/pack/bank parsing is cached in module scope per isolate.
- Rate limits (36 class-ops/hour/IP, 60 transcriptions/hour/IP) and the daily model-call cap live in
  module-scope memory. On Node the process is the unit; on Workers each isolate keeps its own counters, so
  a burst spread across many isolates can exceed the nominal totals. Best effort: the daily cap still bounds
  spend per isolate.
- Workers have no filesystem, so the approved banks are bundled into the Worker (`src/server/worker.ts`
  imports them and calls `setBankFiles`). When a new part is banked, add its JSON import and map entry there
  before redeploying; Node dev keeps reading `content/banks/` from disk.

## M0 — Setup and day-1 checks (§12)

| Check | Result |
|---|---|
| Repo scaffold (§10.3 stack, §10.5 layout) | Done 29 Oct 2026 |
| `npm run dev` on laptop + phone over Wi-Fi | Passed 29 Oct 2026: page 200 at `localhost:5173` and at the LAN URL above; `/api/health` returned `{ "ok": true }` direct and via the Vite proxy |
| CI runs the unit tests | Done 29 Oct 2026: workflow runs `npm ci`, typecheck, `npm test`, build. Locally: 3 Vitest tests pass, typecheck clean, production build succeeds |
| Day-1 check 1: Muse Spark structured output with an enum | Passed 29 Oct 2026: `muse-spark-1.3`, Chat Completions `response_format` json_schema with `strict: true` (§9.1, structured-output docs), schema `Day1Check` with `verdict` enum `covered\|partial\|missed\|wrong`. Returned `{ verdict: "covered", reason: "Teacher explicitly stated la propina is the tip…" }` — valid against the schema. Re-run with `npm run check:day1`. Key read from `.dev.vars`, never printed or logged |
| Day-1 check 2: Voice Transcribe file mode, mixed EN/ES | Passed 30 Oct 2026 — see M3 below (one live call, ≈ $0.002) |
| Day-1 checks 3–5 | Deferred — see Decisions |

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

## M3 — Voice in, file mode (§12)

Done 30 Oct 2026, text-first intact: Type mode works exactly as in M1/M2 (same ChatBox path, same timers when `mode` is `typed`).

| Check | Result |
|---|---|
| Day-1 check 2 (file mode, mixed EN/ES) | Passed live 30 Oct 2026: one call, 41.6 s WAV (Samantha EN + Mexican-Spanish ES, 24 kHz mono 16-bit), `languageBias` `["English","Spanish"]`, the demo part's 16 anchors as `keywords`. All 10 Spanish terms came back correctly spelled with accents (`el menú`, `menú del día`, `quisiera`, `para mí el pollo`, `el mesero`, `la cuenta, por favor`, `buen provecho`, `la propina`, `paella valenciana`, `la carta`). Minor English doubles at the `say`-segment joins ("word for word", "you you"). Cost ≈ $0.002. Audio kept out of the repo (`/tmp/m3voice/`); the recorded response is `tests/fixtures/transcribe-day1.json` |
| Capture + `/api/transcribe` | AudioWorklet mono capture downsampled to 24 kHz int16, WAV-wrapped in shared code, POSTed to `/api/transcribe` (multipart `audio` + `meta` `{packId, partId}`); the server forwards it to `POST https://api.meta.ai/v1/asr/transcribe` (`request` JSON + `audio`, key server-side only) with the part's anchors (≤ 50) as keywords. Each returned turn becomes one transcript line. 120 s timeout, 10 MB cap, WAV-shape check, 60 transcriptions/hour/IP (§10.4), daily-call-cap counted |
| Voice class + answers | Briefing mic check (permission + 2 s level meter, denial falls back to Type); class 3:00 / answers 1:00 in Voice with recording indicator + level meter; transcription failure offers Try again (same WAV) or Type instead; empty transcript keeps the "We didn't catch anything" path |
| Tests | `src/shared/voice.test.ts` (WAV header round-trip, bias/keywords, turn→line mapping against the recorded day-1 response); `tests/transcribe.test.ts` (mocked Meta: line mapping, §9.6 request part, 400s, 502s, 60/hour limit). Full suite: 62 tests pass; typecheck and build clean |
| `bank:audio` | `npm run bank:audio -- <bank file>` records usable questions via ElevenLabs (`eleven_multilingual_v2`) to `public/audio/{packId}/{partId}/{qid}.mp3` with `{file, textHash, voiceId, model}`. With no `ELEVENLABS_API_KEY` it exits 1 with a clear message and changes nothing (verified). No voices picked yet (`content/cast.json` still `<pick>`), so questions stay captions-only per the §12 cut line |
| Realtime captions | Not built tonight (a Should; the cut line ships file mode first) |

Live spend M3: ≈ $0.002 (the single day-1 call). Cumulative live spend: ≈ $0.544.

**Owner, please test by voice in the morning:** on iPhone Safari and a laptop, pick Voice in the briefing (mic check should show the meter), teach the demo class aloud for 3 minutes, answer all three questions by voice, and confirm the lines look right. Then read Appendix C fixture A aloud — M3 acceptance is ≥ 8 of its 10 notes covered. Separately: pick the four ElevenLabs voices (§15 item 3), set `ELEVENLABS_API_KEY`, run `npm run bank:audio -- content/banks/spanish-food-shopping/p10-at-the-restaurant.json`, and listen to every line by ear before approval.

## M4 — The classroom (§12)

Done 30 Oct 2026: `npm run art:build` (new `scripts/art-build.ts`) made all five pictures with Muse Image (`muse-image-1.0`, Responses API, prompt A.6 verbatim), then `art:build -- --finalize` compressed them and `--sam` / `--hand` handled the masks. Every request carried an `image_generation` tool with `enable_web_search: false, enable_image_search: false` (fictional people; the image guide's "Control the tools and reasoning"). Portraits used the classroom picture as the reference image.

| Picture | Kept | Check |
|---|---|---|
| classroom | attempt 1 | Four distinct adults matching the cast left to right (mustard sweater, denim jacket + gray beard, glasses + teal cardigan, red hoodie); calm evening room (lamp, dusk window, plant, desks); blank papers only, no text or logos; flat illustration, no real likeness; nothing unsafe |
| maya | attempt 1 | Same face/hair/sweater/style as the classroom; plain warm background; no text |
| leo | attempt 1 | Same face/beard/jacket/style as the classroom; plain warm background; no text |
| priya | attempt 1 | Same face/glasses/cardigan/style as the classroom; plain warm background; no text |
| sam | attempt 1 | Same face/hair/hoodie/style as the classroom; plain warm background; no text |

No regenerations were needed: 5 image calls of the 20-call budget, 1 attempt per picture of 3 allowed. Candidates lived in `/tmp/m4art/` (never in `public/`); each keeper was viewed before `--finalize` copied it.

Final art (WebP, PIL quality 80): classroom 62,310 B; maya 23,436 B; leo 26,852 B; priya 24,652 B; sam 14,484 B — total 151,734 B (148.2 KB), under the 500 KB acceptance. `content/cast.json` validated complete (`voiceId` still `<pick>`).

SAM 3.1 did not work: two calls (`sam-3.1`, Responses API, prompt `person` on the final classroom picture) each returned a single box around the central figure instead of four. Per §9.8 the Must fallback applies — `public/art/classroom-masks.json` holds hand-set boxes (`"source": "hand"`), verified by eye against a PIL box overlay (each box frames its student, left to right maya/leo/priya/sam). The questions screen outlines the asker and dims the rest from these boxes.

Screens: briefing shows the classroom picture with a named portrait row; class shows it smaller; each question shows the asker's portrait beside the bubble plus the classroom with the asker outlined; grading shows the portrait row. Every picture has alt text (cast descriptions). Layout stays a centered 480 px column, which the spec allows on laptop instead of two panes — nothing overflows at 360/390/1280 px widths (images are `width: 100%`), but no browser lives in this sandbox, so confirm visually in the morning.

Live spend M4: 5 images × $0.01 = $0.05, plus 2 SAM segmentations × $2.50/1,000 ≈ $0.005 — ≈ $0.055. Cumulative live spend: ≈ $0.599.

**Owner, please look at the pictures in the morning:** briefing → Start class → teach → answer three questions, on a phone and a laptop. Check the four faces match their names, the asker lights up in the classroom picture each question, and nothing overflows at your screen size.

### M4 decisions

- 30 Oct 2026 — The client fetches `art/classroom-masks.json` at run time and falls back to the same hand boxes baked into `src/client/art.tsx` when the fetch fails, so the highlight never breaks offline.
- 30 Oct 2026 — Mask overlays render as positioned divs (accent outline + dim), not decoded mask polygons: SAM returned no usable masks, and boxes are all the highlight needs.
- 30 Oct 2026 — `tests/art.test.ts` pins the milestone: cast completeness, five WebP files under 500 KB total, four valid fractional boxes in cast order left to right.

## M5 — Evaluation, accessibility, layout, e2e (§12, owner-independent parts)

Done 30 Oct 2026. Deploy, push and the license wait for the owner (§15 item 1); banks stay `checked`
(human approval is M2/M6 business); voices are still unpicked so questions remain captions-only.

### Grading evaluation (§13): `npm run eval`, live 30 Oct 2026

12 classes (40 spec note verdicts + 88 draft), 11 answer samples (22 points), one model call per class
and per sample, 23 calls in 167 s. Draft labels (`"labelsBy": "draft"`, p11/p12) are owner-unreviewed and
reported separately; prompts were not tuned to any label.

| Fixtures | Notes exact | Notes ±1 step | Points exact | Dropped | Time |
|---|---|---|---|---|---|
| Appendix C, p10 (4 classes, 5 answers) | 40/40 (100%) | 40/40 | 9/10 (90%) | 0 | 62 s |
| Drafts, p11 (4 classes, 3 answers) | 38/44 (86%) | 42/44 | 6/6 (100%) | 0 | 53 s |
| Drafts, p12 (4 classes, 3 answers) | 40/44 (91%) | 42/44 | 5/6 (83%) | 0 | 52 s |
| **Spec total** | **40/40 (100%)** | 40/40 | **9/10 (90%)** | 0 | — |
| **Draft total** | **78/88 (89%)** | 84/88 | **11/12 (92%)** | 0 | — |
| Overall | 118/128 (92%) | 124/128 | 20/22 (91%) | 0 | 167 s |

Against the §13 marks (≥ 85% exact on notes and on points, injection clean): the Appendix C set
**passes both marks**, and the injection fixture's first line changes nothing (`d-injection` 10/10).
Every point miss anywhere was a one-step boundary (hit↔partial); nothing was ever two steps off.

Caveats, kept because they matter more than the headline: (1) the first live run batched each
question's samples into one answers call and scored only 5/10 on points with `dropped: 6` — the model
returned all-none with null quotes. Same-question batching is a situation production never creates
(its three answers are always for three different questions), so `eval` now grades one sample per
call and the batched number is superseded, not hidden. (2) Boundary judgments wobble run to run:
`q-check-comes-automatically/partial` scored 1/2, then 2/2, then 1/2 across runs. (3) Two p12-wrong
draft labels look wrong on their face — the teacher's lines contradict the `fact-cana-y-vino-tinto`
("Cerveza is beer") and `fact-postre-flan-natillas` ("El postre is dessert") notes, so the grader's
`wrong` is likelier right than the draft's `missed`/`partial`; owner review will settle them.
The set stands at 12 of the 30 labeled classes §13 asks for; growing it further needs owner label
review first.

### Accessibility (§11.3)

Checked against the code and computed (all text pairs ≥ 4.5:1, e.g. muted/paper 7.6, accent/paper 7.3,
tile fine/accent 6.0, partial chip 5.7). Fixed: a visible `:focus-visible` outline (there was none —
keyboard users were lost); timers announced exactly at 30 s and 10 s via a screen-reader-only live
region instead of re-announcing every second; "Question N of 3" is now a heading; the settings sheet
is `aria-modal`, closes on Escape, and returns focus to the gear button. Already fine: peek rows are
real buttons (hold Space/Enter past 300 ms, tap mode supported), drawer summary and selects are
native, all inputs labeled, `prefers-reduced-motion` respected, Type mode is a full voice alternative,
captions shown for every question (no audio plays yet — voices unpicked — so there is nothing
uncaptioned).

### Layout (360×800, 390×844, 1280×800)

Fixed two real overflow bugs found by reading the flex rules: the chat input (`width: 100%` inside a
flex row overflowed at 360 px — now `flex: 1 1 auto; min-width: 0`) and the question bubble (added
`min-width: 0`), plus a 44 px minimum on peek rows. The page stays a centered 480 px column on laptop,
which the spec allows. `tests/e2e/audit.spec.ts` walks the whole mocked flow at all three sizes
asserting zero horizontal overflow, ≥ 44 px targets, and a keyboard Space-hold peek — committed, but
**not yet run**: no browser launches in this sandbox (see e2e).

### End-to-end (§13)

`tests/e2e/flow.spec.ts` (390×844, Type, mocked models, Home → debrief, score 63) is written and
statically checked against the current UI, but **not yet run**: Chromium and WebKit were installed
for Playwright and all three binaries (headless shell, full Chromium, system Chrome) abort at launch
here (macOS sandbox denies Mach bootstrap / SIGABRT). Owner: run `npx playwright test` on an
unsandboxed machine — no key needed, every `/api` call is mocked.

Live spend M5: ≈ $0.60 over 62 grading calls (evaluations, probes and reruns at §9.9 rates; under
the $3 step budget). Cumulative live spend: ≈ $1.20.

**Owner, please do in the morning:** (1) `npx playwright test` (needs an unsandboxed browser);
(2) review the 8 draft fixtures (`content/eval/…/p11*/p12*`, especially the two p12-wrong notes above)
and flip `labelsBy` when approved; (3) pick voices, record audio, approve the banks; (4) deploy, rate
limits on; (5) the license.

### M5 decisions

- 30 Oct 2026 — `npm run eval` grades one answer sample per call and reports spec vs draft splits;
  batching same-question samples into one call collapsed the model to all-none (observed 5/10,
  dropped 6) and is not a production situation, so the per-sample procedure supersedes it.
- 30 Oct 2026 — No prompt or code tuning from the eval: all misses are one-step boundaries or
  suspect draft labels, on samples too small to generalize from.
- 30 Oct 2026 — `tests/e2e/audit.spec.ts` is committed unrunnable-here (sandbox kills browser
  processes); the temporary Chromium-only config used to attempt the run was deleted, and
  `test-results/` is gitignored.

## Known issues

- **Browser test hang (30 Oct 2026):** in Playwright's WebKit, with the test's fake microphone (an oscillator stream),
  the page's JavaScript occasionally freezes as class recording starts, so `voice.spec.ts:178` or `timers.spec.ts:201`
  fails about 1 run in 10 (`--repeat-each 30` reproduces it). The frozen page can't answer `page.evaluate`, so no
  in-page timer runs, including the countdown watchdog. Not seen on a real iPhone. Revisit if it appears on a device.

## License

In Character is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Recurxive LLC; see [NOTICE](NOTICE).

"In Character" and "FlashFeed" are trademarks of Recurxive LLC. The Apache License does not grant permission to use
them (section 6).

The lessons come from FlashFeed's public knowledge packs, read at run time from the public catalog. FlashFeed's app,
pack pipeline and catalog code are not part of this repository.

Outside contributions aren't accepted during the hackathon.

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
- 30 Oct 2026 — Day-1 check 2 used macOS voice Paulina (`es_MX`, Mexican Spanish) for the Spanish segments: the requested "Eddy (Spanish (Mexico))" isn't installed on this Mac. The substitution is recorded here; the check still covers Mexican-Spanish terms.
- 30 Oct 2026 — The 41.6 s test WAV came back as a single turn (turnId 0, 0–41100 ms): with no silences between the joined `say` segments, ENDPOINTING had no boundaries to find. Real classes with pauses should endpoint into several turns; each still becomes one line.
- 30 Oct 2026 — M3 cut line: questions show captions without audio until `bank:audio` has recorded them; realtime captions (a Should) are deferred. `bank:audio` exits 1 with a clear message when `ELEVENLABS_API_KEY` is missing (or no cast voices are picked) and changes nothing.
- 30 Oct 2026 — Question `audio.textHash` is sha256 of the spoken text (`ttsText ?? text`); the spec pins the match rule (§7.6) but not the hash input.
- 30 Oct 2026 — The AudioWorklet processor is loaded from a Blob URL (`src/client/voice.ts`), so no extra build step is needed; one shared AudioContext is created on the Start-class tap to satisfy the iOS audio unlock (§4.4).
- 30 Oct 2026 — The day-1 test WAV stays out of the repo (`/tmp/m3voice/`); only its recorded JSON response is kept as `tests/fixtures/transcribe-day1.json`.
- 30 Oct 2026 — Debrief celebration headlines per star (the spec only pins the strong/weak ends): 3 "Congratulations, class dismissed!", 2 "Great class — congratulations!", 1 "Good effort — here's what to teach next time.", 0 "Good start. Here's what to teach next time.". The breakdown reads every number from the score object's new `breakdown` field (`src/shared/scoring.ts`); the UI recomputes nothing.
- 31 Oct 2026 — Voice fixes from iPhone testing: one shared `LevelBar` (`src/client/levelbar.tsx`) renders the recording meter as a thin bar fixed to the top of the viewport (below the safe-area inset), so it survives scrolling on class, answer and mic-check screens; the live region announces "Recording" once and the bar is silent, with a steady red bar plus a twice-a-second numeric level under prefers-reduced-motion. Answers record only after the "Start answer" tap (which also starts the answer timer); the class still auto-records. API failures show `friendlyErrorMessage` wording (`src/shared/errors.ts`) with a "Try again" retry on every surface, and transcribe retries re-send the kept WAV ("Type it instead" falls back to typing).
- 31 Oct 2026 — Kept the reviewer's uncommitted transcribe logging in `src/server/app.ts` / `src/server/transcribe.ts` (message and status only, never the key; `SAVE_FAILED_WAV` debug save stays env-gated) and committed it with the voice fixes.
- 31 Oct 2026 — Done/End stops the timer at once (`src/shared/timed-turn.ts`: first finish wins, first deliver wins; voice shows "Answer sent…" / "Class sent…" with waiting dots while transcribing; a transcription failure's "Type it instead" starts a fresh turn keeping the remaining time). Flaky e2e assertions now wait for stable end states with explicit timeouts instead of asserting transient screens.
- 31 Oct 2026 — Countdown always reaches the class (`src/shared/countdown.ts` + `src/client/Teach.tsx`): the 3-2-1 state machine starts the class exactly once (extra ticks are no-ops), and an absolute watchdog past the last tick starts it even if a tick is ever dropped or delayed — the WebKit freeze on "1" (voice.spec.ts:178, timers.spec.ts:201). A mic start that fails or hangs past `VOICE_START_TIMEOUT_MS` (8 s) falls back to Type on its own with "Mic unavailable — using Type instead.", on the class and on answers; a capture that opens late is stopped at once.
- 31 Oct 2026 — Workers deploy (Free plan): `wrangler.jsonc` names the Worker `incharacter` with `compatibility_date` 2026-10-30 (the newest the wrangler-bundled workerd accepts; 2026-10-31 fails local `wrangler dev`), no `nodejs_compat` (the bundle has no `node:` imports — the disk bank read reaches the fs builtin at run time only, and only on Node). `/api/transcribe` parses the incoming multipart as a stream (zero-copy audio views, byte-counted cap, WAV check on the first 44 bytes) and re-emits the same views to Meta with an exact Content-Length; Content-Length past cap + 64 KB slack rejects up front. Rate limits and the daily cap are per-isolate on Workers (best effort). `SAVE_FAILED_WAV` survives as a `createApp` option wired only by the Node entry.
