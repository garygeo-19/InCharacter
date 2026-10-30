import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { parseUsableStatuses } from '../shared/bank';
import { applyAnswersEvidence, applyClassEvidence } from '../shared/evidence';
import { fetchCatalog, fetchPack, liveEntries } from '../shared/notes';
import { fallbackPick, validatePicks, type UsableQuestion } from '../shared/picker';
import { TRANSCRIBE_MAX_AUDIO_BYTES, turnsToLines, wavProblem } from '../shared/voice';
import { classContent, partStatuses } from './content';
import { requireModelApiKey } from './env';
import { chatStructured, createMetaClient } from './meta';
import { transcribeWav } from './transcribe';
import {
  GRADE_ANSWERS_SYSTEM,
  GRADE_CLASS_SYSTEM,
  PICK_SYSTEM,
  gradeAnswersSchema,
  gradeClassSchema,
  pickSchema,
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

function totalChars(lines: { text: string }[]): number {
  return lines.reduce((s, l) => s + l.text.length, 0);
}

// Per-IP rate limits (§10.4): 36 class-op calls an hour ≈ 12 classes (pick +
// class grade + answers grade each), and 60 transcriptions an hour on the
// transcribe route. Decision 30 Oct 2026.
const HITS = new Map<string, number[]>();
const TRANSCRIBE_HITS = new Map<string, number[]>();
function rateLimited(ip: string, limit = 36, store = HITS): boolean {
  const now = Date.now();
  const kept = (store.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  kept.push(now);
  store.set(ip, kept);
  return kept.length > limit;
}

// Daily model-call cap (§10.4). In-memory; the process is the unit.
let callDay = '';
let callCount = 0;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createApp(env: Record<string, string>) {
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
        })),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // Voice in, file mode (§9.6, §10.2): the browser posts its WAV plus
  // `meta` { packId, partId }; the server forwards it to the Voice API with
  // the part's anchors as keywords. Returns one transcript line per turn.
  const TranscribeMeta = z.object({ packId: z.string(), partId: z.string() });
  app.post('/api/transcribe', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    if (rateLimited(ip, 60, TRANSCRIBE_HITS)) {
      return c.json({ error: 'Too many transcriptions this hour.' }, 429);
    }
    let form: Record<string, string | File>;
    try {
      form = (await c.req.parseBody()) as Record<string, string | File>;
    } catch {
      return c.json({ error: 'Expected multipart audio.' }, 400);
    }
    const audio = form['audio'];
    const metaRaw = form['meta'];
    let metaJson: unknown = metaRaw;
    if (typeof metaRaw === 'string') {
      try {
        metaJson = JSON.parse(metaRaw);
      } catch {
        return c.json({ error: 'Expected multipart audio and meta.' }, 400);
      }
    }
    const meta = TranscribeMeta.safeParse(metaJson);
    if (!(audio instanceof File) || !meta.success) {
      return c.json({ error: 'Expected multipart audio and meta.' }, 400);
    }
    const wav = new Uint8Array(await audio.arrayBuffer());
    if (wav.length > TRANSCRIBE_MAX_AUDIO_BYTES) {
      return c.json({ error: 'Audio is too large (at most 10 MB).' }, 400);
    }
    const problem = wavProblem(wav);
    if (problem) return c.json({ error: problem }, 400);
    try {
      const entry = await catalogEntry(meta.data.packId);
      const pack = await fetchPack(base, entry);
      const { notes } = await classContent(base, entry, meta.data.partId, statuses);
      const anchors = notes.flatMap((n) => n.anchors);
      checkBudget();
      const result = await withTimeout(
        transcribeWav({
          apiKey: requireModelApiKey(env),
          wav,
          packLanguage: pack.language,
          anchors,
        }),
        120_000,
        'transcribe',
      );
      return c.json({ lines: turnsToLines(result.turns), audioDurationMs: result.audioDurationMs });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      return c.json({ error: (err as Error).message }, status as 502);
    }
  });

  app.post('/api/pick', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
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
      const client = createMetaClient(requireModelApiKey(env));
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
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    if (rateLimited(ip)) return c.json({ error: 'Too many classes this hour.' }, 429);
    const parsed = GradeClassBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Bad request.' }, 400);
    const { packId, partId, classLines } = parsed.data;
    if (totalChars(classLines) > 30_000) return c.json({ error: 'Transcript too long.' }, 400);
    const lines = classLines.map((l) => l.text);
    try {
      const entry = await catalogEntry(packId);
      const { notes } = await classContent(base, entry, partId, statuses);
      const client = createMetaClient(requireModelApiKey(env));
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
    const ip = c.req.header('x-forwarded-for') ?? 'local';
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
      const client = createMetaClient(requireModelApiKey(env));
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
