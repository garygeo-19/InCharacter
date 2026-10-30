/**
 * Grading evaluation (REQUIREMENTS.md §13): runs both gradings on every
 * fixture under content/eval/spanish-food-shopping and reports,
 * per fixture and overall: exact agreement with the labels, agreement within
 * one step (notes), the dropped count, and timing.
 *
 * Methodology: one model call per class and one per answer sample. Batching
 * several same-question samples into one answers call collapsed results
 * (all-none with null quotes, dropped>0) — a situation production never
 * creates, since its three answers are always for three different questions.
 *
 * Live model calls: run against the dev server, which holds MODEL_API_KEY.
 * Appendix C fixtures are spec labels; the p11/p12 files are owner-unreviewed
 * drafts ("labelsBy": "draft") and are reported separately.
 *
 * Run: npm run eval [-- --api http://localhost:8787] [-- --part p11-common-foods]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const API = args.includes('--api') ? args[args.indexOf('--api') + 1] : 'http://localhost:8787';
const onlyPart = args.includes('--part') ? args[args.indexOf('--part') + 1] : null;

const EVAL_DIR = resolve(process.cwd(), 'content/eval/spanish-food-shopping');

type Fixtures = {
  packId: string;
  partId: string;
  labelsBy: string;
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

async function post<T>(path: string, body: unknown): Promise<{ data: T; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - started;
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return { data: (await res.json()) as T, ms };
}

async function main() {
  const parts = readdirSync(EVAL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((p) => !onlyPart || p === onlyPart)
    .sort();
  if (parts.length === 0) throw new Error('no fixture parts found');

  let noteExact = 0;
  let noteTotal = 0;
  let noteClose = 0;
  let pointExact = 0;
  let pointTotal = 0;
  let pointClose = 0;
  let dropped = 0;
  let injectionClean: string[] = [];
  const byProvenance: Record<string, { noteExact: number; noteTotal: number; pointExact: number; pointTotal: number; dropped: number }> = {};

  for (const part of parts) {
    const fix = JSON.parse(readFileSync(resolve(EVAL_DIR, part, 'fixtures.json'), 'utf8')) as Fixtures;
    const prov = byProvenance[fix.labelsBy] ?? { noteExact: 0, noteTotal: 0, pointExact: 0, pointTotal: 0, dropped: 0 };
    byProvenance[fix.labelsBy] = prov;
    console.log(`== ${fix.partId} (labelsBy: ${fix.labelsBy}) ==`);

    for (const cls of fix.classes) {
      const { data: grade, ms } = await post<{
        notes: { noteId: string; verdict: string }[];
        moves: unknown[];
        dropped: number;
      }>('/api/grade/class', {
        packId: fix.packId,
        partId: fix.partId,
        classLines: cls.lines.map((text, i) => ({ n: i + 1, text })),
      });
      dropped += grade.dropped;
      prov.dropped += grade.dropped;
      const got = new Map(grade.notes.map((g) => [g.noteId, g.verdict]));
      let exact = 0;
      let close = 0;
      let total = 0;
      const misses: string[] = [];
      for (const [id, want] of Object.entries(cls.labels.notes)) {
        total++;
        noteTotal++;
        prov.noteTotal++;
        if (got.get(id) === want) {
          exact++;
          noteExact++;
          prov.noteExact++;
          close++;
          noteClose++;
        } else if (
          got.get(id) !== 'wrong' && want !== 'wrong' &&
          Math.abs((STEP[got.get(id) ?? ''] ?? 0) - (STEP[want] ?? 0)) <= 1
        ) {
          close++;
          noteClose++;
          misses.push(`${id}: want ${want}, got ${got.get(id)}`);
        } else {
          misses.push(`${id}: want ${want}, got ${got.get(id)}`);
        }
      }
      if (cls.id.includes('injection') && exact === total) injectionClean.push(cls.id);
      console.log(`${cls.id}: notes ${exact}/${total} exact, ${close}/${total} within one step, ${ms}ms`);
      for (const m of misses) console.log(`    ${m}`);
    }

    for (const s of fix.answers) {
      const { data: grade, ms } = await post<{
        answers: { questionId: string; points: { index: number; result: string; quote: string | null }[]; contradictions: unknown[] }[];
        dropped: number;
      }>('/api/grade/answers', {
        packId: fix.packId,
        partId: fix.partId,
        answers: [{
          questionId: s.questionId,
          lines: s.lines.map((text, i) => ({ n: i + 1, text })),
        }],
      });
      dropped += grade.dropped;
      prov.dropped += grade.dropped;
      const got = grade.answers[0];
      let exact = 0;
      let close = 0;
      s.labels.points.forEach((want, j) => {
        pointTotal++;
        prov.pointTotal++;
        if (got.points[j]?.result === want) {
          exact++;
          pointExact++;
          prov.pointExact++;
          close++;
          pointClose++;
        } else if (Math.abs(pointStep(got.points[j]?.result) - pointStep(want)) <= 1) {
          close++;
          pointClose++;
        }
      });
      console.log(`${s.questionId}/${s.id}: points ${exact}/${s.labels.points.length} exact, ${ms}ms`);
      s.labels.points.forEach((want, j) => {
        if (got.points[j]?.result !== want) {
          console.log(`    point ${j}: want ${want}, got ${got.points[j]?.result} quote=${JSON.stringify(got.points[j]?.quote)}`);
        }
      });
    }
  }

  console.log('--- overall ---');
  console.log(`notes: ${noteExact}/${noteTotal} exact, ${noteClose}/${noteTotal} within one step`);
  console.log(`points: ${pointExact}/${pointTotal} exact, ${pointClose}/${pointTotal} within one step`);
  for (const [prov, t] of Object.entries(byProvenance)) {
    console.log(`[${prov}] notes ${t.noteExact}/${t.noteTotal} exact; points ${t.pointExact}/${t.pointTotal} exact; dropped ${t.dropped}`);
  }
  console.log(`dropped: ${dropped}`);
  console.log(`injection clean: ${injectionClean.length > 0 ? injectionClean.join(', ') : onlyPart ? 'not in this run (no injection fixture)' : 'NO'}`);
  console.log('marks: ≥85% exact on notes and points, injection first line changes nothing');
}

function pointStep(r: string | undefined): number {
  return r === 'none' ? 0 : r === 'partial' ? 1 : r === 'hit' ? 2 : -99;
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
