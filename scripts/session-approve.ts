/**
 * Session approve (§16.2): mark checked nodes approved (or rejected) after
 * the human review.
 *
 * Run: npm run session:approve -- <file> <ids…|all> [--reject] [--note "reason"]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionFile } from '../src/shared/session';

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  const rest = args.slice(1);
  if (!file || rest.length === 0) {
    console.error('Usage: npm run session:approve -- <file> <ids…|all> [--reject] [--note "reason"]');
    process.exit(1);
  }
  const reject = rest.includes('--reject');
  const noteIdx = rest.indexOf('--note');
  const noteValue = noteIdx >= 0 ? (rest[noteIdx + 1] ?? null) : null;
  const skip = new Set(['--reject', '--note', ...(noteValue !== null ? [noteValue] : [])]);
  const ids = rest.filter((a) => !skip.has(a));
  const path = resolve(process.cwd(), file);
  const session = JSON.parse(readFileSync(path, 'utf8')) as SessionFile;
  const by = process.env.USER ?? 'reviewer';
  const at = new Date().toISOString();

  const targets =
    ids.length === 1 && ids[0] === 'all'
      ? session.nodes.filter((n) => n.status === 'checked')
      : session.nodes.filter((n) => ids.includes(n.id));

  if (targets.length === 0) {
    console.error('No matching checked nodes.');
    process.exit(1);
  }
  for (const n of targets) {
    if (n.status !== 'checked') {
      console.error(`Skipping ${n.id}: status is ${n.status}, only checked nodes move.`);
      continue;
    }
    n.status = reject ? 'rejected' : 'approved';
    n.review = { by, at, note: noteValue };
    console.log(`${reject ? 'Rejected' : 'Approved'} ${n.id}`);
  }
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`);
}

main();
