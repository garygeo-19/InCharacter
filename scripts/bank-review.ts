/**
 * Bank review (REQUIREMENTS.md §7.5 step 6): print a bank with the verdicts
 * beside each question, for the human reviewer.
 *
 * Run: npm run bank:review -- <file>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bank } from '../src/shared/bank';

function main() {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('Usage: npm run bank:review -- <file>');
    process.exit(1);
  }
  const bank = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')) as Bank;
  console.log(`${bank.packId} / ${bank.partId} (pack ${bank.packVersion}, built ${bank.builtAt})`);
  console.log(`Notes: ${bank.notes.length}. Questions: ${bank.questions.length}.`);
  for (const d of [1, 2, 3]) {
    const at = bank.questions.filter((q) => q.difficulty === d && q.status !== 'rejected');
    console.log(
      `  d${d}: ${at.length} kept (${at.filter((q) => q.status === 'checked').length} checked, ` +
        `${at.filter((q) => q.status === 'approved').length} approved)`,
    );
  }
  console.log(
    `  misconception: ${bank.questions.filter((q) => q.type === 'misconception' && q.status !== 'rejected').length} kept`,
  );
  for (const q of bank.questions) {
    console.log('');
    console.log(`[${q.status}] ${q.id} (${q.type} d${q.difficulty}, ${q.studentId})`);
    console.log(`  "${q.text}"`);
    if (q.ttsText) console.log(`  tts: "${q.ttsText}"`);
    console.log(`  notes: ${q.noteIds.join(', ')}`);
    q.expectedPoints.forEach((p, i) => {
      console.log(`  → (${i}) ${p.point} [${p.noteIds.join(', ')}]`);
    });
    if (q.misconception) console.log(`  wrong belief: ${q.misconception}`);
    const check = q.check as {
      model: string;
      at: string;
      results: Record<string, { pass: boolean; reason: string }>;
    } | null;
    if (check) {
      console.log(`  check (${check.model}):`);
      for (const [k, r] of Object.entries(check.results)) {
        console.log(`    ${r.pass ? '✓' : '✗'} ${k}: ${r.reason}`);
      }
    }
    const review = q.review as { by: string; at: string; note: string | null } | null;
    if (review) console.log(`  review (${review.by}): ${review.note ?? '—'}`);
  }
}

main();
