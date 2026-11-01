/**
 * Session audio (§16.2, §9.7 pattern): pre-record each usable node with its
 * speaker's ElevenLabs voice from the session cast (multi-speaker).
 *
 * Run: npm run session:audio -- content/sessions/<packId>/<partId>.json [--force]
 *
 * - Speech comes from ElevenLabs, recorded ahead of time; nothing is
 *   generated while someone uses the app. Model eleven_v4, which reads
 *   IPA between forward slashes: terms listed in
 *   content/pronunciations/<packId>.json are spoken as /ipa/.
 * - MP3 files go to public/audio/{packId}/{partId}/{nodeId}.mp3, and each
 *   node records { file, textHash, voiceId, model }. The caption always
 *   shows `text`; the voice gets `ttsText` when set, else `text` with the
 *   pronunciations applied. textHash is sha256 of that spoken text.
 * - Up-to-date lines are skipped unless --force is passed.
 * - ELEVENLABS_API_KEY lives only in the local .env/.dev.vars the script
 *   reads. It is never printed or logged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsableStatuses } from '../src/shared/bank';
import { usableSessionNodes, type SessionFile } from '../src/shared/session';
import { sha256Hex } from '../src/shared/sha256';
import { loadEnv } from '../src/server/env';
import { applyPronunciations, type Lexicon } from '../src/shared/pronounce';

const MODEL = 'eleven_v4';

type NodeAudio = { file: string; textHash: string; voiceId: string; model: string };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const [file, ...rest] = process.argv.slice(2).filter((a) => a !== '--force');
  const force = process.argv.includes('--force');
  if (!file || rest.length > 0) fail('Usage: npm run session:audio -- content/sessions/<packId>/<partId>.json [--force]');

  const env = loadEnv();
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    fail(
      'session:audio: ELEVENLABS_API_KEY is not set. Put it in your local .env ' +
        '(see .env.example) and run again. No audio was recorded, and no session file was changed.',
    );
  }

  const session = JSON.parse(readFileSync(file, 'utf8')) as SessionFile;
  const lexiconFile = join(process.cwd(), 'content', 'pronunciations', `${session.packId}.json`);
  const lexicon: Lexicon = existsSync(lexiconFile)
    ? (JSON.parse(readFileSync(lexiconFile, 'utf8')) as { terms: Lexicon }).terms
    : {};
  const voices = new Map(session.cast.map((c) => [c.id, c.voiceId]));
  const missing = session.cast.filter((c) => !c.voiceId || c.voiceId === '<pick>');
  if (missing.length > 0) {
    fail(
      `session:audio: no ElevenLabs voice picked for ${missing.map((c) => c.id).join(', ')} ` +
        '(the session cast still holds "<pick>"). No audio was recorded, and no session file was changed.',
    );
  }

  const statuses = parseUsableStatuses(env.USABLE_STATUSES ?? 'approved,checked');
  const usable = usableSessionNodes(session, statuses);
  const byId = new Map(session.nodes.map((n) => [n.id, n]));
  let recorded = 0;
  let skipped = 0;
  for (const n of usable) {
    const full = byId.get(n.id);
    if (!full) continue;
    const spoken = full.ttsText ?? applyPronunciations(full.text, lexicon);
    const textHash = sha256Hex(spoken);
    const outFile = join('public', 'audio', session.packId, session.partId, `${full.id}.mp3`);
    const current = full.audio as NodeAudio | null;
    if (!force && current?.textHash === textHash && existsSync(join(process.cwd(), outFile))) {
      skipped++;
      continue;
    }
    const voiceId = voices.get(full.speaker);
    if (!voiceId) fail(`session:audio: no voice for speaker ${full.speaker}. No further audio was recorded.`);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text: spoken, model_id: MODEL }),
    });
    if (!res.ok) {
      fail(`session:audio: ElevenLabs returned ${res.status} for ${full.id}. No further audio was recorded.`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    mkdirSync(join(process.cwd(), 'public', 'audio', session.packId, session.partId), { recursive: true });
    writeFileSync(join(process.cwd(), outFile), bytes);
    full.audio = { file: outFile, textHash, voiceId, model: MODEL };
    recorded++;
    console.log(`recorded ${full.id} (${(bytes.length / 1024).toFixed(0)} KB)`);
  }
  writeFileSync(file, JSON.stringify(session, null, 2) + '\n');
  console.log(`session:audio done: ${recorded} recorded, ${skipped} already up to date.`);
}

main().catch((err: unknown) => {
  console.error(`session:audio failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
