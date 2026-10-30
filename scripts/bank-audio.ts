/**
 * Bank audio (REQUIREMENTS.md §9.7): pre-record each usable question with
 * its student's ElevenLabs voice.
 *
 * Run: npm run bank:audio -- content/banks/<packId>/<partId>.json [--force]
 *
 * - Speech comes from ElevenLabs, recorded ahead of time; nothing is
 *   generated while someone uses the app. Model eleven_multilingual_v2
 *   (eleven_v3 when a line sounds flat — set it per question by editing
 *   MODEL below is not supported; re-record with ttsText instead).
 * - MP3 files go to public/audio/{packId}/{partId}/{questionId}.mp3, and
 *   each question records { file, textHash, voiceId, model }. The caption
 *   always shows `text`; `ttsText` (when set) is a respelling for the voice
 *   only. textHash is sha256 of the spoken text (ttsText ?? text).
 * - Up-to-date lines are skipped unless --force is passed.
 * - ELEVENLABS_API_KEY lives only in the local .env/.dev.vars the script
 *   reads. It is never printed or logged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsableStatuses, usableQuestions, type Bank } from '../src/shared/bank';
import { sha256Hex } from '../src/shared/sha256';
import { loadEnv } from '../src/server/env';

const MODEL = 'eleven_multilingual_v2';

type BankAudio = { file: string; textHash: string; voiceId: string; model: string };

type Cast = {
  students: { id: string; voiceId: string }[];
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const [file, ...rest] = process.argv.slice(2).filter((a) => a !== '--force');
  const force = process.argv.includes('--force');
  if (!file) fail('Usage: npm run bank:audio -- content/banks/<packId>/<partId>.json [--force]');

  const env = loadEnv();
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    fail(
      'bank:audio: ELEVENLABS_API_KEY is not set. Put it in your local .env ' +
        '(see .env.example) and run again. No audio was recorded, and no bank file was changed.',
    );
  }

  const bank = JSON.parse(readFileSync(file, 'utf8')) as Bank;
  const cast = JSON.parse(readFileSync(join(process.cwd(), 'content', 'cast.json'), 'utf8')) as Cast;
  const voices = new Map(cast.students.map((s) => [s.id, s.voiceId]));
  const missing = cast.students.filter((s) => !s.voiceId || s.voiceId === '<pick>');
  if (missing.length > 0) {
    fail(
      `bank:audio: no ElevenLabs voice picked for ${missing.map((s) => s.id).join(', ')} ` +
        '(content/cast.json still holds "<pick>"; see REQUIREMENTS.md §15 item 3). ' +
        'No audio was recorded, and no bank file was changed.',
    );
  }

  const statuses = parseUsableStatuses(env.USABLE_STATUSES ?? 'approved,checked');
  const usable = usableQuestions(bank, statuses);
  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  let recorded = 0;
  let skipped = 0;
  for (const q of usable) {
    const full = byId.get(q.id);
    if (!full) continue;
    const spoken = full.ttsText ?? full.text;
    const textHash = sha256Hex(spoken);
    const outFile = join('public', 'audio', bank.packId, bank.partId, `${full.id}.mp3`);
    const current = full.audio as BankAudio | null;
    if (!force && current?.textHash === textHash && existsSync(join(process.cwd(), outFile))) {
      skipped++;
      continue;
    }
    const voiceId = voices.get(full.studentId);
    if (!voiceId) fail(`bank:audio: no voice for student ${full.studentId}. No further audio was recorded.`);
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
      fail(`bank:audio: ElevenLabs returned ${res.status} for ${full.id}. No further audio was recorded.`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    mkdirSync(join(process.cwd(), 'public', 'audio', bank.packId, bank.partId), { recursive: true });
    writeFileSync(join(process.cwd(), outFile), bytes);
    full.audio = { file: outFile, textHash, voiceId, model: MODEL };
    recorded++;
    console.log(`recorded ${full.id} (${(bytes.length / 1024).toFixed(0)} KB)`);
  }
  writeFileSync(file, JSON.stringify(bank, null, 2) + '\n');
  console.log(`bank:audio done: ${recorded} recorded, ${skipped} already up to date.`);
}

main().catch((err: unknown) => {
  console.error(`bank:audio failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
