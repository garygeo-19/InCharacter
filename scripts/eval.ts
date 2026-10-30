/**
 * Grading evaluation (REQUIREMENTS.md §13): runs both gradings on every
 * Appendix C fixture through the dev API and reports exact agreement with
 * the labels, agreement within one step, the dropped count, and timing.
 *
 * Live model calls (~$0.05 a class): run against the dev server, which holds
 * MODEL_API_KEY. Not part of M1 verification; the M1 gate is the mock
 * pipeline (tests/eval-mock.test.ts) plus the mocked Playwright flow.
 *
 * Run: npm run eval [-- --api http://localhost:8787]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = process.argv.includes('--api')
  ? process.argv[process.argv.indexOf('--api') + 1]
  : 'http://localhost:8787';

const PACK_ID = 'spanish-food-shopping';
const PART_ID = 'p10-at-the-restaurant';

type Fixtures = {
  classes: {
    id: string;
    lines: string[];
    labels: { notes: Record<string, string>; moves: string[] };
  }[];
  answers: {
    questionId: string;
    id: string;
    lines: string[];
    labels: { points: string[]; contradictions: number };
  }[];
};

const STEP: Record<string, number> = { missed: 0, partial: 1, covered: 2, wrong: 3 };

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function main() {
  const fix = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'content/eval/spanish-food-shopping/p10-at-the-restaurant/fixtures.json'),
      'utf8',
    ),
  ) as Fixtures;

  let noteExact = 0;
  let noteTotal = 0;
  let noteClose = 0;
  let pointExact = 0;
  let pointTotal = 0;
  let dropped = 0;

  for (const cls of fix.classes) {
    const started = Date.now();
    const grade = await post<{
      notes: { noteId: string; verdict: string }[];
      moves: unknown[];
      dropped: number;
    }>('/api/grade/class', {
      packId: PACK_ID,
      partId: PART_ID,
      classLines: cls.lines.map((text, i) => ({ n: i + 1, text })),
    });
    const ms = Date.now() - started;
    dropped += grade.dropped;
    const got = new Map(grade.notes.map((g) => [g.noteId, g.verdict]));
    let exact = 0;
    let close = 0;
    let total = 0;
    for (const [id, want] of Object.entries(cls.labels.notes)) {
      total++;
      noteTotal++;
      if (got.get(id) === want) {
        exact++;
        noteExact++;
        close++;
        noteClose++;
      } else if (
        got.get(id) !== 'wrong' && want !== 'wrong' &&
        Math.abs((STEP[got.get(id) ?? ''] ?? 0) - (STEP[want] ?? 0)) <= 1
      ) {
        close++;
        noteClose++;
      }
    }
    console.log(`${cls.id}: notes ${exact}/${total} exact, ${close}/${total} within one step, ${ms}ms`);
  }

  const byQ = new Map<string, typeof fix.answers>();
  for (const a of fix.answers) {
    const list = byQ.get(a.questionId) ?? [];
    list.push(a);
    byQ.set(a.questionId, list);
  }
  for (const [questionId, samples] of byQ) {
    const grade = await post<{
      answers: { questionId: string; points: { index: number; result: string }[]; contradictions: unknown[] }[];
      dropped: number;
    }>('/api/grade/answers', {
      packId: PACK_ID,
      partId: PART_ID,
      answers: samples.map((s) => ({
        questionId,
        lines: s.lines.map((text, i) => ({ n: i + 1, text })),
      })),
    });
    dropped += grade.dropped;
    samples.forEach((s, i) => {
      const got = grade.answers[i];
      s.labels.points.forEach((want, j) => {
        pointTotal++;
        if (got.points[j]?.result === want) {
          pointExact++;
        }
      });
    });
  }

  console.log(`notes: ${noteExact}/${noteTotal} exact, ${noteClose}/${noteTotal} within one step`);
  console.log(`points: ${pointExact}/${pointTotal} exact`);
  console.log(`dropped: ${dropped}`);
  console.log('marks: ≥85% exact on notes and points, injection first line changes nothing');
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
