/**
 * Bank build (REQUIREMENTS.md §7.5): notes → writer → code checks → checker → select.
 *
 * Run: npm run bank:build -- <packId> <partId>
 *
 * - Notes come from the live pack (§6.3); nothing is copied into the repo.
 * - Writer: Muse Spark 1.3 at high reasoning (prompt A.4, schema B.4).
 * - Checker: Muse Wonder 1.0 at high reasoning (prompt A.5, schema B.5);
 *   when Wonder isn't available, Muse Spark 1.3 at max reasoning (§7.5 step 4).
 * - Each part is built once per run; the script never loops to chase results.
 * - MODEL_API_KEY is read from .dev.vars and never printed or logged.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyCheckerResults,
  checkBank,
  checkQuestionText,
  isReady,
  notesBlob,
  questionCodeErrors,
  selectBank,
  targetCount,
  type Bank,
  type BankQuestion,
  type CheckerResult,
} from '../src/shared/bank';
import { buildNotes, fetchCatalog, fetchPack, isTeachable, liveEntries } from '../src/shared/notes';
import { loadEnv, requireModelApiKey } from '../src/server/env';
import { chatStructured, createMetaClient, type TokenUsage } from '../src/server/meta';
import {
  BANK_CHECK_SYSTEM,
  bankCheckSchema,
  bankWriteSchema,
  bankWriteSystem,
} from '../src/server/prompts';

type WriterQuestion = {
  id: string;
  type: BankQuestion['type'];
  difficulty: 1 | 2 | 3;
  studentId: BankQuestion['studentId'];
  text: string;
  noteIds: string[];
  expectedPoints: { point: string; noteIds: string[] }[];
  misconception: string | null;
};

// Standard-mode prices per 1M tokens (docs/pricing-rate-limits, 27 Oct 2026).
const RATES: Record<string, { in: number; out: number }> = {
  'muse-spark-1.3': { in: 1.25, out: 4.25 },
  'muse-wonder-1.0': { in: 4.0, out: 20.0 },
};

function cost(usage: TokenUsage, model: string): number {
  const r = RATES[model] ?? RATES['muse-spark-1.3'];
  return (usage.input / 1e6) * r.in + (usage.output / 1e6) * r.out;
}

async function main() {
  const [packId, partId] = process.argv.slice(2);
  if (!packId || !partId) {
    console.error('Usage: npm run bank:build -- <packId> <partId>');
    process.exit(1);
  }
  const env = loadEnv();
  const client = createMetaClient(requireModelApiKey(env));
  const at = new Date().toISOString();
  const usages: { label: string; model: string; usage: TokenUsage }[] = [];
  const track = (label: string, model: string) => (usage: TokenUsage) =>
    usages.push({ label, model, usage });

  const base = env.CATALOG_BASE ?? 'https://flashfeed-packs-serving.vercel.app';
  const entry = liveEntries(await fetchCatalog(base)).find((e) => e.id === packId);
  if (!entry) throw new Error(`Unknown or non-live pack: ${packId}`);
  const pack = await fetchPack(base, entry);
  const lesson = pack.lessons.find((l) => l.parts.some((p) => p.id === partId));
  if (!lesson) throw new Error(`Unknown part: ${partId}`);
  const notes = buildNotes(pack, partId);
  if (!isTeachable(notes)) {
    throw new Error(`Part ${partId} is not teachable (${notes.length} notes); no bank to build.`);
  }

  const outFile = join(process.cwd(), 'content', 'banks', packId, `${partId}.json`);
  try {
    readFileSync(outFile, 'utf8');
    throw new Error(`Refusing to overwrite ${outFile}; remove it first.`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
    // Missing file: this is the expected case.
  }

  const target = targetCount(notes.length);
  const draftCount = Math.min(28, 2 * target);
  const minPerDifficulty = Math.ceil(draftCount / 4);
  console.log(
    `Notes: ${notes.length}. Target: ~${target} kept; drafting ~${draftCount} (≥${minPerDifficulty}/difficulty).`,
  );

  // Step 2: write.
  const writerModel = 'muse-spark-1.3';
  const written = await chatStructured<{ questions: WriterQuestion[] }>({
    client,
    model: writerModel,
    system: bankWriteSystem(draftCount, minPerDifficulty),
    user: JSON.stringify({
      notes: notes.map((n) => ({ id: n.id, label: n.label, text: n.text })),
      count: draftCount,
      minPerDifficulty,
    }),
    schemaName: 'WriteBank',
    schema: bankWriteSchema(notes.map((n) => n.id)),
    reasoningEffort: 'high',
    maxTokens: 16000,
    onUsage: track('write', writerModel),
  });
  console.log(`Writer drafted ${written.questions.length} questions.`);

  let drafts: BankQuestion[] = written.questions.map((q) => ({
    id: q.id,
    status: 'draft' as const,
    type: q.type,
    difficulty: q.difficulty,
    studentId: q.studentId,
    text: q.text,
    ttsText: null,
    noteIds: q.noteIds,
    expectedPoints: q.expectedPoints,
    misconception: q.misconception,
    check: null,
    review: null,
    audio: null,
  }));

  // Duplicate ids: keep the first, reject the rest in code.
  const seen = new Set<string>();
  drafts = drafts.map((q) => {
    if (seen.has(q.id)) {
      return {
        ...q,
        status: 'rejected' as const,
        review: { by: 'code-checks', at, note: `${q.id}: duplicate id` },
      };
    }
    seen.add(q.id);
    return q;
  });

  // Step 3: code checks. Per-question errors reject the question; the reason
  // is recorded on review so the human reviewer can see it.
  const blob = notesBlob(notes);
  const codeErrors = checkBank(
    {
      schemaVersion: 1, packId, packVersion: pack.packVersion, lessonId: lesson.id,
      partId, builtAt: at, notes: [], questions: drafts,
    },
    notes,
  );
  let afterCode: BankQuestion[] = drafts.map((q) => {
    if (q.status === 'rejected') return q;
    const mine = questionCodeErrors(q.id, codeErrors);
    if (mine.length === 0) return q;
    return {
      ...q,
      status: 'rejected' as const,
      review: { by: 'code-checks', at, note: mine.join('; ') },
    };
  });
  const codeRejected = afterCode.filter((q) => q.status === 'rejected');
  console.log(`Code checks rejected ${codeRejected.length}:`);
  for (const q of codeRejected) {
    console.log(`  ✗ ${q.id}: ${(q.review as { note: string }).note}`);
  }
  for (const q of afterCode) {
    if (q.status !== 'draft') continue;
    const { sceneNouns } = checkQuestionText(q.text, blob, q.id);
    if (sceneNouns.length > 0) {
      console.log(`  scene nouns for reviewer — ${q.id}: ${sceneNouns.join(', ')}`);
    }
  }

  // Step 4: check. One call over the code-passing questions.
  const checkable = afterCode.filter((q) => q.status === 'draft');
  let checkerModel = 'muse-wonder-1.0';
  let results: CheckerResult[] = [];
  if (checkable.length > 0) {
    const user = JSON.stringify({
      notes: notes.map((n) => ({ id: n.id, label: n.label, text: n.text })),
      questions: checkable.map((q) => ({
        id: q.id,
        type: q.type,
        difficulty: q.difficulty,
        studentId: q.studentId,
        text: q.text,
        noteIds: q.noteIds,
        expectedPoints: q.expectedPoints,
        misconception: q.misconception,
      })),
    });
    const runCheck = (model: string, effort: 'high' | 'max') =>
      chatStructured<{ results: CheckerResult[] }>({
        client,
        model,
        system: BANK_CHECK_SYSTEM,
        user,
        schemaName: 'CheckBank',
        schema: bankCheckSchema(checkable.map((q) => q.id)),
        reasoningEffort: effort,
        maxTokens: 16000,
        onUsage: track('check', model),
      });
    try {
      ({ results } = (await runCheck('muse-wonder-1.0', 'high')) as { results: CheckerResult[] });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 404 || status === 403) {
        checkerModel = 'muse-spark-1.3';
        console.log('Muse Wonder is not available; checking with Muse Spark 1.3 at max reasoning.');
        ({ results } = (await runCheck('muse-spark-1.3', 'max')) as { results: CheckerResult[] });
      } else {
        throw err;
      }
    }
    afterCode = applyCheckerResults(afterCode, results, checkerModel, at);
  }
  const checkerRejected = afterCode.filter(
    (q) => q.status === 'rejected' && (q.review as { by?: string } | null)?.by !== 'code-checks',
  );
  console.log(`Checker (${checkerModel}) rejected ${checkerRejected.length}:`);
  for (const q of checkerRejected) {
    const check = q.check as {
      results: Record<string, { pass: boolean; reason: string }>;
    };
    const fails = Object.entries(check.results)
      .filter(([, r]) => !r.pass)
      .map(([k, r]) => `${k}: ${r.reason}`);
    console.log(`  ✗ ${q.id}: ${fails.join(' | ')}`);
  }

  // Step 5: select.
  const picked = selectBank(afterCode, notes);
  const keptIds = new Set(picked.map((q) => q.id));
  const finalQuestions = afterCode.map((q) => (keptIds.has(q.id) ? { ...q, status: 'checked' as const } : q));
  const kept = finalQuestions.filter((q) => q.status === 'checked');

  const bank: Bank = {
    schemaVersion: 1,
    packId,
    packVersion: pack.packVersion,
    lessonId: lesson.id,
    partId,
    builtAt: at.slice(0, 10),
    notes: notes.map((n) => ({ id: n.id, hash: n.hash })),
    questions: finalQuestions,
  };
  const bankErrors = checkBank({ ...bank, questions: kept }, notes);
  mkdirSync(join(process.cwd(), 'content', 'banks', packId), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(bank, null, 2)}\n`);
  console.log(`Wrote ${outFile}`);

  const byDiff = [1, 2, 3].map((d) => kept.filter((q) => q.difficulty === d).length);
  console.log(
    `Kept ${kept.length} (d1: ${byDiff[0]}, d2: ${byDiff[1]}, d3: ${byDiff[2]}, ` +
      `misconception: ${kept.filter((q) => q.type === 'misconception').length}). ` +
      `Ready: ${isReady(kept)}.`,
  );
  if (bankErrors.length > 0) {
    console.log('Kept set still fails code checks (left for the reviewer):');
    for (const e of bankErrors) console.log(`  ! ${e}`);
  }

  let total = 0;
  for (const u of usages) {
    const dollars = cost(u.usage, u.model);
    total += dollars;
    console.log(
      `  ${u.label} (${u.model}): ${u.usage.input} in / ${u.usage.output} out` +
        (u.usage.reasoning ? ` (reasoning ${u.usage.reasoning})` : '') +
        ` ≈ $${dollars.toFixed(3)}`,
    );
  }
  console.log(`Rough credit spend for this build: ≈ $${total.toFixed(3)}.`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  // Status only; never the key or request bodies.
  console.error(JSON.stringify({ ok: false, status: status ?? null, error: message }));
  process.exit(1);
});
