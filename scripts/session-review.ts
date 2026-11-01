/**
 * Session review (REQUIREMENTS.md §16.2): print a session with the verdicts
 * beside each node, for the human reviewer.
 *
 * Run: npm run session:review -- <file>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionFile } from '../src/shared/session';

function main() {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('Usage: npm run session:review -- <file>');
    process.exit(1);
  }
  const session = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')) as SessionFile;
  console.log(`${session.packId} / ${session.partId} (${session.role}, pack ${session.packVersion}, built ${session.builtAt})`);
  console.log(`Brief: ${session.brief}`);
  console.log(`Cast: ${session.cast.map((c) => `${c.name} (${c.id})`).join(', ')}. Scene: ${session.scene}.`);
  console.log(`Notes: ${session.notes.length}. Nodes: ${session.nodes.length} (start: ${session.start}).`);
  for (const n of session.nodes) {
    console.log('');
    console.log(`[${n.status}] ${n.id} (${n.speaker}${n.end ? ', end' : n.reply ? '' : ', narration'})`);
    console.log(`  "${n.text}"`);
    if (n.gloss) console.log(`  gloss: "${n.gloss}"`);
    if (n.ttsText) console.log(`  tts: "${n.ttsText}"`);
    console.log(`  notes: ${n.noteIds.join(', ')}`);
    n.expectedPoints.forEach((p, i) => {
      console.log(`  → (${i}) ${p.text} [${p.noteIds.join(', ')}]`);
    });
    for (const r of n.routes) {
      console.log(`  ⇒ ${r.id}: ${r.when} → ${r.next}`);
    }
    if (n.default) console.log(`  default → ${n.default}`);
    const check = n.check as {
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
    const review = n.review as { by: string; at: string; note: string | null } | null;
    if (review) console.log(`  review (${review.by}): ${review.note ?? '—'}`);
    const audio = n.audio as { file: string; voiceId: string; model: string } | null;
    if (audio) console.log(`  audio: ${audio.file} (${audio.model})`);
  }
}

main();
