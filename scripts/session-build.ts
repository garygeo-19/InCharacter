/**
 * Session build (REQUIREMENTS.md §16.2): notes → writer → code checks → checker.
 *
 * Run: npm run session:build -- <packId> <partId> --role coach|travel
 *
 * - Notes come from the live pack (§6.3); nothing is copied into the repo.
 * - Writer: Muse Spark 1.3 at high reasoning (prompt A.8/A.9, schema B.7).
 * - Checker: Muse Wonder 1.0 at high reasoning (A.5-like prompt, schema B.8),
 *   checking each node's grounding and the writer rules; when Wonder isn't
 *   available, Muse Spark 1.3 at max reasoning (same pattern as bank:build).
 * - Code checks: line lengths, note ids, graph rules (§16.2). Per-node
 *   errors reject the node; the reason is recorded on review.
 * - Statuses draft/checked as banks: passing nodes are marked `checked`.
 * - MODEL_API_KEY is read from .dev.vars and never printed or logged.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAnswerKey, notesBlob } from '../src/shared/bank';
import {
  applySessionCheckerResults,
  checkSessionFile,
  sessionNodeCodeErrors,
  type SessionCheckerResult,
  type SessionFile,
  type SessionNode,
  type SessionRole,
} from '../src/shared/session';
import { buildNotes, fetchCatalog, fetchPack, isTeachable, liveEntries } from '../src/shared/notes';
import { loadEnv, requireModelApiKey } from '../src/server/env';
import { chatStructured, createMetaClient, type TokenUsage } from '../src/server/meta';
import {
  SESSION_CHECK_SYSTEM,
  sessionCheckSchema,
  sessionWriteSchema,
  sessionWriteSystem,
} from '../src/server/prompts';

const RATES: Record<string, { in: number; out: number }> = {
  'muse-spark-1.3': { in: 1.25, out: 4.25 },
  'muse-wonder-1.0': { in: 4.0, out: 20.0 },
};

function cost(usage: TokenUsage, model: string): number {
  const r = RATES[model] ?? RATES['muse-spark-1.3'];
  return (usage.input / 1e6) * r.in + (usage.output / 1e6) * r.out;
}

type WriterNode = {
  id: string;
  speaker: string;
  text: string;
  gloss: string | null;
  noteIds: string[];
  expectedPoints: { text: string; noteIds: string[] }[];
  routes: { id: string; when: string; next: string }[];
  default: string | null;
  end: boolean;
  reply: boolean;
};

type WriterCast = { id: string; name: string; description: string };

async function main() {
  const argv = process.argv.slice(2);
  const roleIdx = argv.indexOf('--role');
  const role = (roleIdx >= 0 ? argv[roleIdx + 1] : null) as SessionRole | null;
  const [packId, partId] = argv.filter((a) => a !== '--role' && a !== role);
  if (!packId || !partId || (role !== 'coach' && role !== 'travel')) {
    console.error('Usage: npm run session:build -- <packId> <partId> --role coach|travel');
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
    throw new Error(`Part ${partId} is not teachable (${notes.length} notes); no session to build.`);
  }

  const outFile = join(process.cwd(), 'content', 'sessions', packId, `${partId}.json`);
  try {
    readFileSync(outFile, 'utf8');
    throw new Error(`Refusing to overwrite ${outFile}; remove it first.`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
  }

  // Step 2: write.
  const writerModel = 'muse-spark-1.3';
  const written = await chatStructured<{
    brief: string;
    cast: WriterCast[];
    scene: string;
    start: string;
    nodes: WriterNode[];
  }>({
    client,
    model: writerModel,
    system: sessionWriteSystem(role),
    user: JSON.stringify({
      notes: notes.map((n) => ({ id: n.id, label: n.label, text: n.text })),
    }),
    schemaName: 'WriteSession',
    schema: sessionWriteSchema(notes.map((n) => n.id)),
    reasoningEffort: 'high',
    maxTokens: 16000,
    onUsage: track('write', writerModel),
  });
  console.log(`Writer drafted ${written.nodes.length} nodes.`);

  let drafts: SessionNode[] = written.nodes.map((n) => ({
    id: n.id,
    status: 'draft' as const,
    speaker: n.speaker,
    text: n.text,
    gloss: n.gloss,
    scene: null,
    ttsText: null,
    noteIds: n.noteIds,
    expectedPoints: n.expectedPoints,
    routes: n.routes,
    default: n.default,
    end: n.end,
    reply: n.reply,
    check: null,
    review: null,
    audio: null,
  }));

  const draftFile: SessionFile = {
    schemaVersion: 1,
    role,
    packId,
    packVersion: pack.packVersion,
    lessonId: lesson.id,
    partId,
    builtAt: at.slice(0, 10),
    notes: notes.map((n) => ({ id: n.id, hash: n.hash })),
    brief: written.brief,
    cast: written.cast.map((c) => ({
      id: c.id, name: c.name, description: c.description,
      voiceId: '<pick>', portrait: `art/${role}/${c.id}.webp`,
    })),
    scene: written.scene || `art/${role}/scene.webp`,
    start: written.start,
    nodes: drafts,
  };

  // Step 3: code checks (lengths, note ids, graph rules). Per-node errors
  // reject the node; the nothing-new-in-the-answer-key check (§7.5) runs on
  // each expected point.
  const blob = notesBlob(notes);
  const keyErrors: string[] = [];
  for (const n of drafts) {
    n.expectedPoints.forEach((p, i) => {
      keyErrors.push(...checkAnswerKey(p.text, blob, `${n.id} point ${i}`));
    });
  }
  const codeErrors = [...checkSessionFile(draftFile, notes), ...keyErrors];
  let afterCode: SessionNode[] = drafts.map((n) => {
    const mine = [...sessionNodeCodeErrors(n.id, codeErrors)];
    if (mine.length === 0) return n;
    return {
      ...n,
      status: 'rejected' as const,
      review: { by: 'code-checks', at, note: mine.join('; ') },
    };
  });
  const codeRejected = afterCode.filter((n) => n.status === 'rejected');
  console.log(`Code checks rejected ${codeRejected.length}:`);
  for (const n of codeRejected) {
    console.log(`  ✗ ${n.id}: ${(n.review as { note: string }).note}`);
  }

  // Step 4: check. One call over the code-passing nodes.
  const checkable = afterCode.filter((n) => n.status === 'draft');
  let checkerModel = 'muse-wonder-1.0';
  if (checkable.length > 0) {
    const user = JSON.stringify({
      role,
      notes: notes.map((n) => ({ id: n.id, label: n.label, text: n.text })),
      nodes: checkable.map((n) => ({
        id: n.id,
        speaker: n.speaker,
        text: n.text,
        gloss: n.gloss,
        noteIds: n.noteIds,
        expectedPoints: n.expectedPoints,
        routes: n.routes,
        default: n.default,
        end: n.end,
        reply: n.reply,
      })),
    });
    const runCheck = (model: string, effort: 'high' | 'max') =>
      chatStructured<{ results: SessionCheckerResult[] }>({
        client,
        model,
        system: SESSION_CHECK_SYSTEM,
        user,
        schemaName: 'CheckSession',
        schema: sessionCheckSchema(checkable.map((n) => n.id)),
        reasoningEffort: effort,
        maxTokens: 16000,
        onUsage: track('check', model),
      });
    let results: SessionCheckerResult[] = [];
    try {
      ({ results } = await runCheck('muse-wonder-1.0', 'high'));
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 404 || status === 403) {
        checkerModel = 'muse-spark-1.3';
        console.log('Muse Wonder is not available; checking with Muse Spark 1.3 at max reasoning.');
        ({ results } = await runCheck('muse-spark-1.3', 'max'));
      } else {
        throw err;
      }
    }
    afterCode = applySessionCheckerResults(afterCode, results, checkerModel, at);
  }
  const checkerRejected = afterCode.filter(
    (n) => n.status === 'rejected' && (n.review as { by?: string } | null)?.by !== 'code-checks',
  );
  console.log(`Checker (${checkerModel}) rejected ${checkerRejected.length}:`);
  for (const n of checkerRejected) {
    const check = n.check as { results: Record<string, { pass: boolean; reason: string }> };
    const fails = Object.entries(check.results)
      .filter(([, r]) => !r.pass)
      .map(([k, r]) => `${k}: ${r.reason}`);
    console.log(`  ✗ ${n.id}: ${fails.join(' | ')}`);
  }

  const kept = afterCode.filter((n) => n.status === 'draft').map((n) => ({ ...n, status: 'checked' as const }));
  const keptIds = new Set(kept.map((n) => n.id));
  const finalNodes = afterCode.map((n) => (keptIds.has(n.id) ? { ...n, status: 'checked' as const } : n));
  drafts = finalNodes;

  const session: SessionFile = { ...draftFile, nodes: drafts };
  const keptErrors = checkSessionFile({ ...session, nodes: kept }, notes);
  mkdirSync(join(process.cwd(), 'content', 'sessions', packId), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(session, null, 2)}\n`);
  console.log(`Wrote ${outFile}`);
  console.log(`Kept ${kept.length} of ${drafts.length} nodes (checked).`);
  if (keptErrors.length > 0) {
    console.log('Kept set still fails code checks (left for the reviewer):');
    for (const e of keptErrors) console.log(`  ! ${e}`);
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
  console.error(JSON.stringify({ ok: false, status: status ?? null, error: message }));
  process.exit(1);
});
