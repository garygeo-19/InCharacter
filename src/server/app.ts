import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { parseUsableStatuses } from '../shared/bank';
import { applyAnswersEvidence, applyClassEvidence } from '../shared/evidence';
import { fetchCatalog, fetchPack, liveEntries } from '../shared/notes';
import { fallbackPick, validatePicks, type UsableQuestion } from '../shared/picker';
import { questionAudioUrl } from '../shared/question-audio';
import { resolveTurn } from '../shared/session';
import { TRANSCRIBE_MAX_AUDIO_BYTES, turnsToLines, wavProblem } from '../shared/voice';
import { classContent, partStatuses, sessionContent } from './content';
import { requireModelApiKey } from './env-shared';
import { chatStructured, createMetaClient } from './meta';
import { transcribeStream } from './transcribe';
import {
  extractBoundary,
  parseTranscribeUpload,
  TRANSCRIBE_UPLOAD_SLACK_BYTES,
  type ParsedUpload,
} from './transcribe-stream';
import {
  GRADE_ANSWERS_SYSTEM,
  GRADE_CLASS_SYSTEM,
  PICK_SYSTEM,
  TURN_SYSTEM,
  gradeAnswersSchema,
  gradeClassSchema,
  pickSchema,
  turnSchema,
} from './prompts';

// Hono app (REQUIREMENTS.md §10.2/§10.3). Runs on Node in dev and on
// Cloudflare Workers when deployed (M5). Prompts are built here; the
// client never sends one.

const LineSchema = z.object({ n: z.number(), text: z.string() });
const PickBody = z.object({
  packId: z.string(),
  partId: z.string(),
  classLines: z.array(LineSchema).max(400),
  excludeIds: z.array(z.string()).default([]),
});
const GradeClassBody = z.object({
  packId: z.string(),
  partId: z.string(),
  classLines: z.array(LineSchema).max(400),
});
const GradeAnswersBody = z.object({
  packId: z.string(),
  partId: z.string(),
  answers: z
    .array(z.object({ questionId: z.string(), lines: z.array(LineSchema).max(400) }))
    .max(3),
});
const TurnBody = z.object({
  packId: z.string(),
  partId: z.string(),
  nodeId: z.string(),
  lines: z.array(LineSchema).max(400),
  visited: z.array(z.string()).default([]),
});
const GradeSessionBody = z.object({
  packId: z.string(),
  partId: z.string(),
  answers: z
    .array(z.object({ nodeId: z.string(), lines: z.array(LineSchema).max(400) }))
    .max(8),
});

function totalChars(lines: { text: string }[]): number {
  return lines.reduce((s, l) => s + l.text.length, 0);
}

// Per-IP rate limits (§10.4, §16.3): 72 class-op calls an hour on the
// shared class-op counter (pick, class grade, answers grade, turn, session
// grade). A teach class costs 3 calls and a full 9-node coach session costs
// up to 9 (8 turns + 1 session grade), so 72 fits e.g. 12 classes plus 4
// sessions an hour. Transcriptions keep their own counter (240/hour, chunked
// upload, owner fix 31 Oct 2026). Decision 30 Oct 2026, raised 31 Oct 2026
// (transcribe split) and 1 Nov 2026 (36 → 72 for sessions). These counters
// live in module scope: on Node the process is the unit; on Workers each
// isolate keeps its own (best effort — see README "Deploy").
const CLASS_OP_LIMIT = 72;
const HITS = new Map<string, number[]>();
const TRANSCRIBE_HITS = new Map<string, number[]>();
function rateLimited(ip: string, limit = CLASS_OP_LIMIT, store = HITS): boolean {
  const now = Date.now();
  const kept = (store.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  kept.push(now);
  store.set(ip, kept);
  return kept.length > limit;
}

function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
}

// Daily model-call cap (§10.4). In-memory; the process is the unit on Node,
// one isolate's share on Workers (see README "Deploy").
let callDay = '';
let callCount = 0;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createApp(
  env: Record<string, string>,
  opts?: { saveFailedWav?: (wav: Uint8Array) => void; modelFetch?: typeof fetch },
) {
  const app = new Hono();
  const origin = env.APP_ORIGIN ?? 'http://localhost:5173';
  app.use('/api/*', cors({ origin: [origin, 'http://localhost:5173'] }));

  const base = env.CATALOG_BASE ?? 'https://flashfeed-packs-serving.vercel.app';
  const statuses = parseUsableStatuses(env.USABLE_STATUSES);
  const dailyCap = Number(env.DAILY_CALL_CAP ?? 3000);

  async function catalogEntry(packId: string) {
    const entries = liveEntries(await fetchCatalog(base));
    const entry = entries.find((e) => e.id === packId);
    if (!entry) throw new Error(`Unknown pack: ${packId}`);
    return entry;
  }

  function checkBudget() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== callDay) {
      callDay = today;
      callCount = 0;
    }
    if (callCount >= dailyCap) {
      const err = new Error('The class is full today. Come back tomorrow.') as Error & {
        status?: number;
      };
      err.status = 503;
      throw err;
    }
    callCount++;
  }

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/catalog', async (c) => {
    try {
      const entries = liveEntries(await fetchCatalog(base));
      return c.json({
        packs: entries.map((e) => ({
          id: e.id, name: e.name, shortName: e.shortName, icon: e.icon,
          version: e.version, description: e.description, language: e.language,
          lessonCount: e.lessonCount, cardCount: e.cardCount,
        })),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.get('/api/pack/:packId', async (c) => {
    try {
      const pack = await fetchPack(base, await catalogEntry(c.req.param('packId')));
      return c.json({
        packId: pack.packId, packName: pack.packName, packVersion: pack.packVersion,
        language: pack.language, lessons: pack.lessons, items: pack.items,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.get('/api/parts/:packId', async (c) => {
    try {
      return c.json({
        packId: c.req.param('packId'),
        ...(await partStatuses(base, await catalogEntry(c.req.param('packId')), statuses)),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.get('/api/bank/:packId/:partId', async (c) => {
    try {
      const entry = await catalogEntry(c.req.param('packId'));
      const { questions } = await classContent(base, entry, c.req.param('partId'), statuses);
      return c.json({
        questions: questions.map((q) => ({
          id: q.id, text: q.text, type: q.type, difficulty: q.difficulty,
          studentId: q.studentId, noteIds: q.noteIds,
          expectedPoints: q.expectedPoints, misconception: q.misconception,
          // The mp3 URL only; the client never sees voiceId (§9.7).
          // The recorded textHash is trusted; only the file path is checked.
          audioUrl: questionAudioUrl(c.req.param('packId'), c.req.param('partId'), q.id, q.audio),
        })),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // Sessions (§16.2–16.3): the playable script for one part. Usable
  // sessions only; node audio goes out as mp3 URLs like banks, and the
  // client never sees voiceId.
  app.get('/api/session/:packId/:partId', async (c) => {
    try {
      const entry = await catalogEntry(c.req.param('packId'));
      const { session } = await sessionContent(base, entry, c.req.param('partId'), statuses);
      const wantRole = c.req.query('role');
      if (wantRole && wantRole !== session.role) {
        return c.json({ error: 'No usable session for this role.' }, 404);
      }
      return c.json({
        role: session.role,
        brief: session.brief,
        cast: session.cast.map(({ id, name, description, portrait }) => ({
          id, name, description, portrait,
        })),
        scene: session.scene,
        start: session.start,
        // The walking map (§16.6): each route's moves plus the session map.
        // Old sessions without them expose []/null; the client stays put.
        map: session.map ?? null,
        nodes: session.nodes.map((n) => ({
          id: n.id,
          speaker: n.speaker,
          text: n.text,
          gloss: n.gloss,
          scene: n.scene ?? session.scene,
          reply: n.reply,
          end: n.end,
          noteIds: n.noteIds,
          expectedPoints: n.expectedPoints,
          routes: n.routes.map((r) => ({ id: r.id, moves: r.moves ?? [] })),
          audioUrl: questionAudioUrl(c.req.param('packId'), c.req.param('partId'), n.id, n.audio),
        })),
      });
    } catch (err) {
      const message = (err as Error).message;
      const missing = message === 'no usable session for this part' || message.startsWith('Unknown part');
      return c.json({ error: message }, missing ? 404 : 502);
    }
  });

  // Game master (§16.3): after each reply, route to the next checked line.
  // muse-spark-1.3 at low reasoning with an 8 s timeout and an enum output
  // (the node's route ids plus "unclear"); code maps "unclear", a timeout
  // or an invalid answer to `default`, and a revisited node follows
  // `default` without calling the model (no loops).
  app.post('/api/turn', async (c) => {
    const ip = clientIp(c);
    if (rateLimited(ip)) return c.json({ error: 'Too many classes this hour.' }, 429);
    const parsed = TurnBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Bad request.' }, 400);
    const { packId, partId, nodeId, lines, visited } = parsed.data;
    if (totalChars(lines) > 30_000) return c.json({ error: 'Reply too long.' }, 400);
    try {
      const entry = await catalogEntry(packId);
      const { notes, session } = await sessionContent(base, entry, partId, statuses);
      const node = session.nodes.find((n) => n.id === nodeId);
      if (!node) return c.json({ error: 'Unknown node.' }, 400);
      if (!node.reply || visited.includes(node.id)) {
        return c.json(resolveTurn(node, null, visited));
      }
      const noteTexts = new Map(notes.map((n) => [n.id, n.text]));
      const client = createMetaClient(requireModelApiKey(env), opts?.modelFetch);
      const input = JSON.stringify({
        line: node.text,
        notes: node.noteIds.map((id) => ({ id, text: noteTexts.get(id) ?? '' })),
        routes: node.routes.map((r) => ({ id: r.id, when: r.when })),
        reply: lines.map((l, i) => `L${i + 1}: ${l.text}`),
      });
      try {
        checkBudget();
        const model = await withTimeout(
          chatStructured<{ route: string }>({
            client, model: 'muse-spark-1.3', system: TURN_SYSTEM, user: input,
            schemaName: 'GameMasterTurn',
            schema: turnSchema(node.routes.map((r) => r.id)),
            reasoningEffort: 'low',
          }),
          8000,
          'turn',
        );
        return c.json(resolveTurn(node, model.route, visited));
      } catch {
        // Unclear, timeout or invalid answer: the default (§16.3).
        return c.json(resolveTurn(node, null, visited));
      }
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      return c.json({ error: (err as Error).message }, status as 502);
    }
  });

  // Session grading (§16.3): one call when the session ends. Each visited
  // reply node grades as a "question" through the answers grader (A.3/B.3)
  // with the reply as its answer; the evidence rules (§8.5) apply.
  app.post('/api/grade/session', async (c) => {
    const ip = clientIp(c);
    if (rateLimited(ip)) return c.json({ error: 'Too many classes this hour.' }, 429);
    const parsed = GradeSessionBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Bad request.' }, 400);
    const { packId, partId, answers } = parsed.data;
    if (answers.some((a) => totalChars(a.lines) > 30_000)) {
      return c.json({ error: 'Answer too long.' }, 400);
    }
    try {
      const entry = await catalogEntry(packId);
      const { notes, session } = await sessionContent(base, entry, partId, statuses);
      const byId = new Map(session.nodes.map((n) => [n.id, n]));
      const noteTexts = new Map(notes.map((n) => [n.id, n.text]));
      const picked = answers.map((a) => a.nodeId);
      const client = createMetaClient(requireModelApiKey(env), opts?.modelFetch);
      const input = JSON.stringify(
        answers.map((a) => {
          const n = byId.get(a.nodeId);
          if (!n) throw new Error(`Unknown node: ${a.nodeId}`);
          return {
            questionId: n.id,
            text: n.text,
            type: 'apply',
            misconception: null,
            expectedPoints: n.expectedPoints.map((p, i) => ({ index: i, point: p.text })),
            notes: n.noteIds.map((id) => ({ id, text: noteTexts.get(id) ?? '' })),
            answer: a.lines.map((l, i) => `L${i + 1}: ${l.text}`),
          };
        }),
      );
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          checkBudget();
          const model = await withTimeout(
            chatStructured<{ answers: { questionId: string; points: { index: number; result: string; quote: string | null }[]; contradictions: { quote: string; noteId: string; why: string }[] }[] }>({
              client, model: 'muse-spark-1.3', system: GRADE_ANSWERS_SYSTEM, user: input,
              schemaName: 'GradeSession',
              schema: gradeAnswersSchema(picked, notes.map((n) => n.id)),
              reasoningEffort: 'medium',
            }),
            30_000,
            'grade/session',
          );
          const checked = applyAnswersEvidence(
            {
              answers: model.answers.map((a) => ({
                questionId: a.questionId,
                points: a.points.map((p) => ({
                  index: p.index,
                  result: p.result as 'hit' | 'partial' | 'none',
                  quote: p.quote,
                })),
                contradictions: a.contradictions ?? [],
              })),
            },
            new Map(answers.map((a) => [a.nodeId, a.lines.map((l) => l.text)])),
          );
          return c.json({
            answers: checked.answers.map((a) => ({ ...a, nodeId: a.questionId })),
            dropped: checked.dropped,
          });
        } catch (err) {
          lastError = err;
        }
      }
      return c.json({ error: `Grading failed: ${(lastError as Error)?.message ?? 'unknown'}` }, 502);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      return c.json({ error: (err as Error).message }, status as 502);
    }
  });

  // Voice in, file mode (§9.6, §10.2): the browser posts its WAV plus
  // `meta` { packId, partId }; the server forwards it to the Voice API with
  // the part's anchors as keywords. Returns one transcript line per turn.
  // The upload is walked as a stream (never buffered and re-encoded), so a
  // multi-MB WAV stays within the Workers Free-plan CPU budget.
  const TranscribeMeta = z.object({ packId: z.string(), partId: z.string() });
  app.post('/api/transcribe', async (c) => {
    const ip = clientIp(c);
    if (rateLimited(ip, 240, TRANSCRIBE_HITS)) {
      return c.json({ error: 'Too many transcriptions this hour.' }, 429);
    }
    // Fast path: the whole body is the audio plus a few hundred bytes of
    // form overhead, so past cap + slack the audio itself is over the cap.
    const contentLength = Number(c.req.header('content-length') ?? '');
    if (
      Number.isFinite(contentLength) &&
      contentLength > TRANSCRIBE_MAX_AUDIO_BYTES + TRANSCRIBE_UPLOAD_SLACK_BYTES
    ) {
      return c.json({ error: 'Audio is too large (at most 10 MB).' }, 400);
    }
    let upload: ParsedUpload;
    try {
      upload = await parseTranscribeUpload(
        c.req.raw.body,
        extractBoundary(c.req.header('content-type')) ?? '',
      );
    } catch {
      return c.json({ error: 'Expected multipart audio.' }, 400);
    }
    let metaJson: unknown = upload.metaRaw;
    if (typeof upload.metaRaw === 'string') {
      try {
        metaJson = JSON.parse(upload.metaRaw);
      } catch {
        return c.json({ error: 'Expected multipart audio and meta.' }, 400);
      }
    }
    const meta = TranscribeMeta.safeParse(metaJson);
    if (!upload.audioFound || !meta.success) {
      return c.json({ error: 'Expected multipart audio and meta.' }, 400);
    }
    if (upload.tooLarge || upload.audioBytes > TRANSCRIBE_MAX_AUDIO_BYTES) {
      return c.json({ error: 'Audio is too large (at most 10 MB).' }, 400);
    }
    const problem = wavProblem(upload.head);
    if (problem) {
      console.error('[transcribe] bad wav:', problem, `wav=${upload.audioBytes}B`);
      return c.json({ error: problem }, 400);
    }
    try {
      const entry = await catalogEntry(meta.data.packId);
      const pack = await fetchPack(base, entry);
      const { notes } = await classContent(base, entry, meta.data.partId, statuses);
      const anchors = notes.flatMap((n) => n.anchors);
      checkBudget();
      const result = await withTimeout(
        transcribeStream({
          apiKey: requireModelApiKey(env),
          audio: upload.audioChunks,
          audioBytes: upload.audioBytes,
          packLanguage: pack.language,
          anchors,
        }),
        120_000,
        'transcribe',
      );
      return c.json({ lines: turnsToLines(result.turns), audioDurationMs: result.audioDurationMs });
    } catch (err) {
      // Message and status only, never the key or headers.
      if (opts?.saveFailedWav && !upload.tooLarge) {
        try {
          const flat = new Uint8Array(upload.audioBytes);
          let o = 0;
          for (const chunk of upload.audioChunks) {
            flat.set(chunk, o);
            o += chunk.length;
          }
          opts.saveFailedWav(flat);
        } catch {
          // Debug save must never break the error response.
        }
      }
      console.error('[transcribe] failed:', (err as { status?: number }).status ?? '-', (err as Error).message, `wav=${upload.audioBytes}B`);
      const status = (err as { status?: number }).status ?? 502;
      return c.json({ error: (err as Error).message }, status as 502);
    }
  });

  app.post('/api/pick', async (c) => {
    const ip = clientIp(c);
    if (rateLimited(ip)) return c.json({ error: 'Too many classes this hour.' }, 429);
    const parsed = PickBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Bad request.' }, 400);
    const { packId, partId, classLines, excludeIds } = parsed.data;
    if (totalChars(classLines) > 30_000) return c.json({ error: 'Transcript too long.' }, 400);
    try {
      const entry = await catalogEntry(packId);
      const { notes, questions } = await classContent(base, entry, partId, statuses);
      const words = new Map(notes.map((n) => [n.id, n.evidenceWords]));
      const usable: UsableQuestion[] = questions.map((q, i) => ({
        id: q.id,
        difficulty: q.difficulty,
        noteIds: q.noteIds,
        evidenceWords: [...new Set(q.noteIds.flatMap((id) => words.get(id) ?? []))],
        bankIndex: i,
      }));
      const transcript = classLines.map((l) => l.text).join('\n');
      const client = createMetaClient(requireModelApiKey(env), opts?.modelFetch);
      const input = JSON.stringify({
        notes: notes.map((n) => ({ id: n.id, label: n.label, text: n.text })),
        transcript: classLines.map((l, i) => `L${i + 1}: ${l.text}`),
        bank: questions.map((q) => ({
          id: q.id, difficulty: q.difficulty, type: q.type, noteIds: q.noteIds, text: q.text,
        })),
        excludeIds,
      });
      try {
        checkBudget();
        const model = await withTimeout(
          chatStructured<{ picks: { questionId: string; reason: string }[] }>({
            client, model: 'muse-spark-1.3', system: PICK_SYSTEM, user: input,
            schemaName: 'PickQuestions', schema: pickSchema(usable.map((q) => q.id)),
            reasoningEffort: 'low',
          }),
          6000,
          'pick',
        );
        const ids = model.picks.map((p) => ({ questionId: p.questionId }));
        if (validatePicks(ids, usable, excludeIds).length === 0) {
          return c.json({ picks: ids, source: 'model' });
        }
      } catch {
        // Validation failure, timeout or model error: the fallback (§9.2).
      }
      return c.json({ picks: fallbackPick(usable, excludeIds, transcript), source: 'fallback' });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      return c.json({ error: (err as Error).message }, status as 502);
    }
  });

  app.post('/api/grade/class', async (c) => {
    const ip = clientIp(c);
    if (rateLimited(ip)) return c.json({ error: 'Too many classes this hour.' }, 429);
    const parsed = GradeClassBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Bad request.' }, 400);
    const { packId, partId, classLines } = parsed.data;
    if (totalChars(classLines) > 30_000) return c.json({ error: 'Transcript too long.' }, 400);
    const lines = classLines.map((l) => l.text);
    try {
      const entry = await catalogEntry(packId);
      const { notes } = await classContent(base, entry, partId, statuses);
      const client = createMetaClient(requireModelApiKey(env), opts?.modelFetch);
      const input = JSON.stringify({
        notes: notes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, text: n.text })),
        transcript: classLines.map((l, i) => `L${i + 1}: ${l.text}`),
      });
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          checkBudget();
          const model = await withTimeout(
            chatStructured<{ notes: { noteId: string; verdict: string; quotes: string[]; why: string }[]; moves: { move: string; quote: string }[] }>({
              client, model: 'muse-spark-1.3', system: GRADE_CLASS_SYSTEM, user: input,
              schemaName: 'GradeClass',
              schema: gradeClassSchema(notes.map((n) => n.id)),
              reasoningEffort: 'medium',
            }),
            45_000,
            'grade/class',
          );
          const checked = applyClassEvidence(
            {
              notes: model.notes.map((g) => ({
                noteId: g.noteId,
                verdict: g.verdict as 'covered' | 'partial' | 'missed' | 'wrong',
                quotes: g.quotes ?? [],
                why: g.why ?? '',
              })),
              moves: model.moves ?? [],
            },
            notes,
            lines,
          );
          return c.json(checked);
        } catch (err) {
          lastError = err;
        }
      }
      return c.json({ error: `Grading failed: ${(lastError as Error)?.message ?? 'unknown'}` }, 502);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      return c.json({ error: (err as Error).message }, status as 502);
    }
  });

  app.post('/api/grade/answers', async (c) => {
    const ip = clientIp(c);
    if (rateLimited(ip)) return c.json({ error: 'Too many classes this hour.' }, 429);
    const parsed = GradeAnswersBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Bad request.' }, 400);
    const { packId, partId, answers } = parsed.data;
    if (answers.some((a) => totalChars(a.lines) > 30_000)) {
      return c.json({ error: 'Answer too long.' }, 400);
    }
    try {
      const entry = await catalogEntry(packId);
      const { notes, questions } = await classContent(base, entry, partId, statuses);
      const byId = new Map(questions.map((q) => [q.id, q]));
      const noteTexts = new Map(notes.map((n) => [n.id, n.text]));
      const picked = answers.map((a) => a.questionId);
      const client = createMetaClient(requireModelApiKey(env), opts?.modelFetch);
      const input = JSON.stringify(
        answers.map((a) => {
          const q = byId.get(a.questionId);
          if (!q) throw new Error(`Unknown question: ${a.questionId}`);
          return {
            questionId: q.id,
            text: q.text,
            type: q.type,
            misconception: q.misconception,
            expectedPoints: q.expectedPoints.map((p, i) => ({ index: i, point: p.point })),
            notes: q.noteIds.map((id) => ({ id, text: noteTexts.get(id) ?? '' })),
            answer: a.lines.map((l, i) => `L${i + 1}: ${l.text}`),
          };
        }),
      );
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          checkBudget();
          const model = await withTimeout(
            chatStructured<{ answers: { questionId: string; points: { index: number; result: string; quote: string | null }[]; contradictions: { quote: string; noteId: string; why: string }[] }[] }>({
              client, model: 'muse-spark-1.3', system: GRADE_ANSWERS_SYSTEM, user: input,
              schemaName: 'GradeAnswers',
              schema: gradeAnswersSchema(picked, notes.map((n) => n.id)),
              reasoningEffort: 'medium',
            }),
            30_000,
            'grade/answers',
          );
          const checked = applyAnswersEvidence(
            {
              answers: model.answers.map((a) => ({
                questionId: a.questionId,
                points: a.points.map((p) => ({
                  index: p.index,
                  result: p.result as 'hit' | 'partial' | 'none',
                  quote: p.quote,
                })),
                contradictions: a.contradictions ?? [],
              })),
            },
            new Map(answers.map((a) => [a.questionId, a.lines.map((l) => l.text)])),
          );
          return c.json(checked);
        } catch (err) {
          lastError = err;
        }
      }
      return c.json({ error: `Grading failed: ${(lastError as Error)?.message ?? 'unknown'}` }, 502);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      return c.json({ error: (err as Error).message }, status as 502);
    }
  });

  return app;
}
