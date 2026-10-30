/**
 * Bank approve (REQUIREMENTS.md §7.5 step 6): mark checked questions approved
 * (or rejected) after the human review.
 *
 * Run: npm run bank:approve -- <file> <ids…|all> [--reject] [--note "reason"]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bank } from '../src/shared/bank';

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  const rest = args.slice(1);
  if (!file || rest.length === 0) {
    console.error('Usage: npm run bank:approve -- <file> <ids…|all> [--reject] [--note "reason"]');
    process.exit(1);
  }
  const reject = rest.includes('--reject');
  const noteIdx = rest.indexOf('--note');
  const noteValue = noteIdx >= 0 ? (rest[noteIdx + 1] ?? null) : null;
  const skip = new Set(['--reject', '--note', ...(noteValue !== null ? [noteValue] : [])]);
  const ids = rest.filter((a) => !skip.has(a));
  const path = resolve(process.cwd(), file);
  const bank = JSON.parse(readFileSync(path, 'utf8')) as Bank;
  const by = process.env.USER ?? 'reviewer';
  const at = new Date().toISOString();

  const targets =
    ids.length === 1 && ids[0] === 'all'
      ? bank.questions.filter((q) => q.status === 'checked')
      : bank.questions.filter((q) => ids.includes(q.id));

  if (targets.length === 0) {
    console.error('No matching checked questions.');
    process.exit(1);
  }
  for (const q of targets) {
    if (q.status !== 'checked') {
      console.error(`Skipping ${q.id}: status is ${q.status}, only checked questions move.`);
      continue;
    }
    q.status = reject ? 'rejected' : 'approved';
    q.review = { by, at, note: noteValue };
    console.log(`${reject ? 'Rejected' : 'Approved'} ${q.id}`);
  }
  writeFileSync(path, `${JSON.stringify(bank, null, 2)}\n`);
}

main();
