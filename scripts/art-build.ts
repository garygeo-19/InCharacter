/**
 * Art build (REQUIREMENTS.md §9.8, prompt A.6, milestone M4).
 *
 * Run: npm run art:build [-- --only classroom|maya|leo|priya|sam]
 *      npm run art:build -- --finalize [--keep classroom=1,maya=1,leo=1,priya=1,sam=1]
 *      npm run art:build -- --sam [--hand boxes.json]
 *
 * - Muse Image (muse-image-1.0, Responses API, docs/image-generation):
 *   classroom first (prompt A.6 verbatim), then one portrait per student
 *   with the classroom picture as the reference image. The built-in web
 *   and image search stay OFF (fictional people; see "Control the tools
 *   and reasoning" in the image guide): the request carries an
 *   `image_generation` tool with enable_web_search/enable_image_search
 *   set to false.
 * - Budget (§12 M4): at most 3 attempts per picture, at most 20 image
 *   calls in total. Attempts are counted in a ledger file and enforced
 *   before each call; transport retries on 429/5xx don't count as
 *   attempts. The human operator inspects every candidate before it is
 *   kept (candidates live in CAND_DIR, never in public/).
 * - --finalize compresses the kept attempts to WebP via PIL so the five
 *   files total under 500 KB, writes public/art/, and validates
 *   content/cast.json (voiceId stays "<pick>").
 * - --sam runs SAM 3.1 (sam-3.1, Responses API, prompt "person") on the
 *   final classroom picture and saves public/art/classroom-masks.json
 *   with boxes assigned to the cast left to right. --hand writes the
 *   Must fallback (hand-set boxes) instead.
 * - Roles (§16): --session content/sessions/<packId>/<partId>.json draws a
 *   role's cast portraits from the session file's cast descriptions plus
 *   its scene (from --scene-prompt, or a per-role default when omitted),
 *   in the same warm flat style as the classroom art. --only limits the
 *   pictures to <castId>|scene; --finalize compresses the kept attempts to
 *   public/art/<role>/ and the scene path. Not run by the roles milestone.
 * - MODEL_API_KEY is read from .dev.vars and never printed or logged;
 *   only counts, sizes and statuses are logged.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireModelApiKey } from '../src/server/env';
import { SessionFileSchema } from '../src/shared/session';

const API = 'https://api.meta.ai/v1/responses';
const IMAGE_MODEL = 'muse-image-1.0';
const SAM_MODEL = 'sam-3.1';
const MAX_ATTEMPTS_PER_PICTURE = 3;
const MAX_IMAGE_CALLS = 20;
const SIZE_BUDGET_BYTES = 500 * 1024;

const CAND_DIR = '/tmp/m4art/candidates';
const LEDGER_FILE = '/tmp/m4art/ledger.json';
const ART_DIR = join(process.cwd(), 'public', 'art');
const STUDENTS_DIR = join(ART_DIR, 'students');

const CLASSROOM_PROMPT = `A warm, flat illustration of a small evening class, seen from the teacher's place at the front. Four adult students sit at simple desks facing the viewer, attentive and friendly. From left to right: Maya, a woman in her thirties with curly dark hair and a mustard sweater; Leo, a man in his sixties with a gray beard and a denim jacket; Priya, a woman in her forties with glasses and a teal cardigan; Sam, a man in his twenties with short hair and a red hoodie. Soft lamp light, a window at dusk, a plant. Each student fully visible, evenly spaced. No text, letters, logos or brand marks anywhere.`;

const CAST: { id: string; name: string; description: string }[] = [
  { id: 'maya', name: 'Maya', description: 'in her thirties, curly dark hair, mustard sweater' },
  { id: 'leo', name: 'Leo', description: 'in his sixties, gray beard, denim jacket' },
  { id: 'priya', name: 'Priya', description: 'in her forties, glasses, teal cardigan' },
  { id: 'sam', name: 'Sam', description: 'in his twenties, short hair, red hoodie' },
];

function portraitPrompt(name: string, description: string): string {
  return `From this classroom picture, make a head-and-shoulders portrait of ${name}, ${description}: the same face, hair, clothes and illustration style. Plain warm background, looking at the viewer with a friendly expression. No text.`;
}

type Ledger = { imageCalls: number; attempts: Record<string, number> };

function loadLedger(): Ledger {
  try {
    return JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as Ledger;
  } catch {
    return { imageCalls: 0, attempts: {} };
  }
}

function saveLedger(ledger: Ledger): void {
  mkdirSync('/tmp/m4art', { recursive: true });
  writeFileSync(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function postResponses(key: string, body: unknown, timeoutMs: number): Promise<unknown> {
  let lastStatus = 0;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      lastStatus = res.status;
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        try {
          const errJson = (await res.json()) as { error?: { message?: string } };
          if (errJson?.error?.message) lastError += `: ${errJson.error.message}`;
        } catch {
          // Keep the status only.
        }
        const retryAfter = res.headers.get('retry-after');
        if (attempt === 0 && isRetryable(res.status)) {
          const waitMs = retryAfter ? Number(retryAfter) * 1000 : 1000 + Math.random() * 1000;
          await new Promise((r) => setTimeout(r, Number.isFinite(waitMs) ? waitMs : 1000));
          continue;
        }
        throw new Error(lastError);
      }
      return (await res.json()) as unknown;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('HTTP')) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw new Error(`Request failed: ${lastError}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Request failed: ${lastError} (status ${lastStatus})`);
}

function extractImageB64(response: unknown): string {
  const output = (response as { output?: unknown[] })?.output;
  if (!Array.isArray(output)) throw new Error('Image response has no output array');
  for (const item of output) {
    const typed = item as { type?: string; result?: unknown };
    if (typed?.type === 'image_generation_call' && typeof typed.result === 'string') {
      return typed.result;
    }
  }
  throw new Error('Image response has no image_generation_call item');
}

function imageTools(size: string): unknown[] {
  // Fictional people: built-in web and image search stay off
  // (docs/image-generation "Control the tools and reasoning").
  return [
    {
      type: 'image_generation',
      enable_web_search: false,
      enable_image_search: false,
      output_format: 'webp',
      size,
    },
  ];
}

async function generatePicture(opts: {
  key: string;
  pic: string;
  prompt: string;
  referenceB64: string | null;
  size: string;
}): Promise<void> {
  const ledger = loadLedger();
  const used = ledger.attempts[opts.pic] ?? 0;
  if (used >= MAX_ATTEMPTS_PER_PICTURE) {
    throw new Error(`${opts.pic}: already at ${MAX_ATTEMPTS_PER_PICTURE} attempts; not looping past the cap.`);
  }
  if (ledger.imageCalls >= MAX_IMAGE_CALLS) {
    throw new Error(`Already at ${MAX_IMAGE_CALLS} image calls; stopping.`);
  }
  const input: unknown =
    opts.referenceB64 === null
      ? opts.prompt
      : [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: opts.prompt },
              { type: 'input_image', image_url: `data:image/webp;base64,${opts.referenceB64}` },
            ],
          },
        ];
  ledger.imageCalls += 1;
  ledger.attempts[opts.pic] = used + 1;
  saveLedger(ledger);
  const attempt = used + 1;
  console.log(`${opts.pic}: attempt ${attempt} (image call ${ledger.imageCalls}/${MAX_IMAGE_CALLS})…`);
  const response = await postResponses(
    opts.key,
    { model: IMAGE_MODEL, input, tools: imageTools(opts.size) },
    300_000,
  );
  const b64 = extractImageB64(response);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error(`${opts.pic} attempt ${attempt}: returned bytes are not WebP; inspect before keeping.`);
  }
  mkdirSync(CAND_DIR, { recursive: true });
  const file = join(CAND_DIR, `${opts.pic}-attempt${attempt}.webp`);
  writeFileSync(file, bytes);
  console.log(`${opts.pic} attempt ${attempt}: saved candidate ${file} (${bytes.length} bytes). Inspect it before keeping.`);
}

function latestCandidate(pic: string, attempt: number | null): string {
  if (attempt !== null) {
    const file = join(CAND_DIR, `${pic}-attempt${attempt}.webp`);
    if (!existsSync(file)) throw new Error(`No candidate ${file}; generate it first.`);
    return file;
  }
  const ledger = loadLedger();
  const used = ledger.attempts[pic] ?? 0;
  for (let n = used; n >= 1; n--) {
    const file = join(CAND_DIR, `${pic}-attempt${n}.webp`);
    if (existsSync(file)) return file;
  }
  throw new Error(`No candidates for ${pic}; generate one first.`);
}

function finalize(keep: Record<string, number>): void {
  mkdirSync(STUDENTS_DIR, { recursive: true });
  const files: { pic: string; src: string; dest: string; maxW: number }[] = [
    { pic: 'classroom', src: latestCandidate('classroom', keep.classroom ?? null), dest: join(ART_DIR, 'classroom.webp'), maxW: 1024 },
    ...CAST.map((s) => ({
      pic: s.id,
      src: latestCandidate(s.id, keep[s.id] ?? null),
      dest: join(STUDENTS_DIR, `${s.id}.webp`),
      maxW: 512,
    })),
  ];
  // Compress with PIL: shrink to maxW, then lower quality until the five
  // files total under 500 KB.
  const spec = JSON.stringify(files.map((f) => ({ src: f.src, dest: f.dest, maxW: f.maxW })));
  const py = `
import json, sys
from PIL import Image
spec = json.loads(sys.argv[1])
budget = int(sys.argv[2])
for quality in (80, 70, 60, 50, 40, 30):
    total = 0
    for item in spec:
        im = Image.open(item["src"]).convert("RGB")
        if im.width > item["maxW"]:
            im = im.resize((item["maxW"], round(im.height * item["maxW"] / im.width)), Image.LANCZOS)
        im.save(item["dest"], "WEBP", quality=quality, method=6)
    import os
    total = sum(os.path.getsize(item["dest"]) for item in spec)
    print(f"quality {quality}: total {total} bytes")
    if total <= budget:
        break
else:
    sys.exit("over budget at quality 30")
`;
  try {
    const out = execFileSync('python3', ['-c', py, spec, String(SIZE_BUDGET_BYTES)], { encoding: 'utf8' });
    console.log(out.trim());
  } catch (err) {
    throw new Error(`Compression failed: ${(err as Error).message}`);
  }
  const sizes = files.map((f) => ({ file: f.dest, bytes: readFileSync(f.dest).length }));
  const total = sizes.reduce((s, x) => s + x.bytes, 0);
  console.log(`Final art total: ${total} bytes (${(total / 1024).toFixed(1)} KB):`);
  for (const s of sizes) console.log(`  ${s.file}: ${s.bytes} bytes`);
  if (total > SIZE_BUDGET_BYTES) throw new Error('Art is over the 500 KB budget.');

  // cast.json is complete when every portrait exists; voiceId stays "<pick>".
  const castPath = join(process.cwd(), 'content', 'cast.json');
  const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
    classroom: string;
    masks: string;
    students: { id: string; portrait: string; voiceId: string }[];
  };
  if (cast.classroom !== 'art/classroom.webp') throw new Error('cast.json classroom path changed; expected art/classroom.webp');
  if (cast.masks !== 'art/classroom-masks.json') throw new Error('cast.json masks path changed; expected art/classroom-masks.json');
  for (const s of CAST) {
    const entry = cast.students.find((x) => x.id === s.id);
    if (!entry) throw new Error(`cast.json is missing student ${s.id}`);
    if (entry.portrait !== `art/students/${s.id}.webp`) {
      throw new Error(`cast.json portrait for ${s.id} changed; expected art/students/${s.id}.webp`);
    }
    if (entry.voiceId !== '<pick>') throw new Error(`cast.json voiceId for ${s.id} is no longer <pick>; voices are picked later.`);
    if (!existsSync(join(process.cwd(), 'public', entry.portrait))) {
      throw new Error(`Missing portrait file public/${entry.portrait}`);
    }
  }
  if (!existsSync(join(ART_DIR, 'classroom.webp'))) throw new Error('Missing public/art/classroom.webp');
  console.log('cast.json complete (voiceId still <pick>).');
}

type Box = { x1: number; y1: number; x2: number; y2: number };

function parseSamBoxes(text: string): { boxes: Box[]; frameW: number; frameH: number; masks: string[] } {
  // One line per frame; a single image emits "<0f>id<box><mask>,id<box><mask>".
  const records = text.split(/(?<=}>\s*),(?=\d+<\|box;)/);
  const boxes: Box[] = [];
  const masks: string[] = [];
  let frameW = 0;
  let frameH = 0;
  const boxRe = /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)[^|]*\|>/;
  const maskRe = /<\|mask;.*?\|>/;
  for (const record of records) {
    const box = boxRe.exec(record);
    const mask = maskRe.exec(record);
    if (!box || !mask) continue;
    boxes.push({
      x1: Number(box[1]),
      y1: Number(box[2]),
      x2: Number(box[3]),
      y2: Number(box[4]),
    });
    masks.push(mask[0]);
    frameW = Number(box[5]);
    frameH = Number(box[6]);
  }
  return { boxes, frameW, frameH, masks };
}

function extractOutputText(response: unknown): string {
  const output = (response as { output?: unknown[] })?.output;
  if (!Array.isArray(output)) throw new Error('SAM response has no output array');
  const texts: string[] = [];
  for (const item of output) {
    const typed = item as { type?: string; content?: { type?: string; text?: string }[] };
    if (typed?.type === 'message' && Array.isArray(typed.content)) {
      for (const part of typed.content) {
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
          texts.push(part.text);
        }
      }
    }
  }
  return texts.join('\n');
}

async function runSam(key: string): Promise<void> {
  const classroom = join(ART_DIR, 'classroom.webp');
  if (!existsSync(classroom)) throw new Error('Finalize the classroom picture first (public/art/classroom.webp).');
  const b64 = readFileSync(classroom).toString('base64');
  console.log('SAM 3.1: segmenting classroom with prompt "person"…');
  const response = await postResponses(
    key,
    {
      model: SAM_MODEL,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'person' },
            { type: 'input_image', image_url: `data:image/webp;base64,${b64}` },
          ],
        },
      ],
    },
    120_000,
  );
  const text = extractOutputText(response);
  if (!text.trim()) throw new Error('SAM returned no segments (zero matches is valid output, but not usable here).');
  if (process.env.ART_DEBUG) {
    console.log(`SAM raw output (${text.length} chars): ${text.slice(0, 600)}`);
  }
  const { boxes, frameW, frameH, masks } = parseSamBoxes(text);
  console.log(`SAM returned ${boxes.length} boxes (frame ${frameW}x${frameH}).`);
  if (boxes.length !== 4 || frameW <= 0 || frameH <= 0) {
    throw new Error(
      `SAM found ${boxes.length} people, not 4; inspect the overlay and either retry SAM or use --hand (Must fallback).`,
    );
  }
  // Assign to the cast left to right (§9.8).
  const order = boxes
    .map((box, i) => ({ box, mask: masks[i], cx: (box.x1 + box.x2) / 2 }))
    .sort((a, b) => a.cx - b.cx);
  const segments = order.map((o, i) => ({
    studentId: CAST[i].id,
    box: {
      x1: o.box.x1 / frameW,
      y1: o.box.y1 / frameH,
      x2: o.box.x2 / frameW,
      y2: o.box.y2 / frameH,
    },
    mask: o.mask,
  }));
  const out = {
    image: 'art/classroom.webp',
    width: frameW,
    height: frameH,
    source: 'sam-3.1',
    prompt: 'person',
    segments,
  };
  writeFileSync(join(ART_DIR, 'classroom-masks.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log('Wrote public/art/classroom-masks.json (sam-3.1, left-to-right). Check the overlay by eye.');
}

function writeHandBoxes(file: string): void {
  // Must fallback: boxes set by hand as fractions of the picture (§9.8).
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    segments: { studentId: string; box: Box }[];
  };
  if (!Array.isArray(raw.segments) || raw.segments.length !== 4) {
    throw new Error('Hand boxes file must hold segments for all four students.');
  }
  const ids = new Set(CAST.map((s) => s.id));
  for (const seg of raw.segments) {
    if (!ids.has(seg.studentId)) throw new Error(`Unknown student ${seg.studentId} in hand boxes.`);
    for (const k of ['x1', 'y1', 'x2', 'y2'] as const) {
      const v = seg.box[k];
      if (typeof v !== 'number' || v < 0 || v > 1) throw new Error(`Hand box ${seg.studentId}.${k} must be a 0–1 fraction.`);
    }
    if (!(seg.box.x1 < seg.box.x2 && seg.box.y1 < seg.box.y2)) {
      throw new Error(`Hand box for ${seg.studentId} is inverted.`);
    }
  }
  const sorted = [...raw.segments].sort((a, b) => a.box.x1 - b.box.x1);
  const order = sorted.map((s) => s.studentId).join(',');
  if (order !== 'maya,leo,priya,sam') {
    throw new Error(`Hand boxes must run left to right (maya,leo,priya,sam); got ${order}.`);
  }
  const out = {
    image: 'art/classroom.webp',
    width: 0,
    height: 0,
    source: 'hand' as const,
    prompt: 'person',
    segments: raw.segments.map((s) => ({ studentId: s.studentId, box: s.box, mask: null })),
  };
  writeFileSync(join(ART_DIR, 'classroom-masks.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log('Wrote public/art/classroom-masks.json (hand boxes, Must fallback).');
}

// --- Roles (§16): cast portraits + scene from a session file ----------------
// Portraits are drawn from the session file's cast descriptions in the same
// warm flat style as the classroom art (the style travels in the prompt;
// the classroom reference candidates no longer exist). The session file
// carries no scene description, so the scene prompt comes from
// --scene-prompt, falling back to a per-role default (Decision 1 Nov 2026).

const ROLE_SCENE_PROMPTS: Record<string, string> = {
  coach:
    'A warm, flat illustration of a calm coaching room: two comfortable chairs, a small table with a notebook, a window with daylight, a plant. No people, no text, letters, logos or brand marks anywhere.',
  travel:
    'A warm, flat illustration of a small Mexican town square at midday: a bandstand, colorful facades, a church tower, string lights. No people, no text, letters, logos or brand marks anywhere.',
};

function rolePortraitPrompt(name: string, description: string): string {
  return `A warm, flat illustration in the same style as the classroom picture: a head-and-shoulders portrait of ${name}, ${description}. Plain warm background, looking at the viewer with a friendly expression. No text, letters, logos or brand marks anywhere.`;
}

async function runRoleSession(opts: {
  key: string;
  file: string;
  only: string[] | null;
  scenePrompt: string | null;
  keep: Record<string, number>;
  finalizeOnly: boolean;
}): Promise<void> {
  const raw = JSON.parse(readFileSync(opts.file, 'utf8')) as unknown;
  const session = SessionFileSchema.parse(raw);
  const role = session.role;
  const pics = opts.only ?? [...session.cast.map((c) => c.id), 'scene'];
  for (const pic of pics) {
    if (pic !== 'scene' && !session.cast.some((c) => c.id === pic)) {
      throw new Error(`Unknown picture --only ${pic} for ${opts.file}; use a cast id or scene.`);
    }
  }
  const scenePrompt = opts.scenePrompt ?? ROLE_SCENE_PROMPTS[role];
  if (!scenePrompt) throw new Error(`No scene prompt for role ${role}; pass --scene-prompt "...".`);
  if (!opts.finalizeOnly) {
    for (const pic of pics) {
      if (pic === 'scene') {
        await generatePicture({ key: opts.key, pic: `${role}-scene`, prompt: scenePrompt, referenceB64: null, size: '1536x1024' });
      } else {
        const member = session.cast.find((c) => c.id === pic)!;
        await generatePicture({
          key: opts.key,
          pic: `${role}-${pic}`,
          prompt: rolePortraitPrompt(member.name, member.description),
          referenceB64: null,
          size: '1024x1024',
        });
      }
    }
    const ledger = loadLedger();
    console.log(
      `Ledger: ${ledger.imageCalls} image calls total, attempts ${JSON.stringify(ledger.attempts)}. ` +
        `Rough image spend: $${(ledger.imageCalls * 0.01).toFixed(2)} (billed only for returned images, $0.01 each).`,
    );
    return;
  }
  // Finalize: portraits to public/art/<role>/, the scene to the session's
  // scene path, all as WebP.
  const roleDir = join(process.cwd(), 'public', 'art', role);
  mkdirSync(roleDir, { recursive: true });
  const files: { pic: string; src: string; dest: string; maxW: number }[] = [];
  for (const pic of pics) {
    if (pic === 'scene') {
      files.push({
        pic: `${role}-scene`,
        src: latestCandidate(`${role}-scene`, opts.keep.scene ?? opts.keep[`${role}-scene`] ?? null),
        dest: join(process.cwd(), 'public', session.scene),
        maxW: 1024,
      });
    } else {
      const member = session.cast.find((c) => c.id === pic)!;
      files.push({
        pic: `${role}-${pic}`,
        src: latestCandidate(`${role}-${pic}`, opts.keep[pic] ?? null),
        dest: join(roleDir, `${member.id}.webp`),
        maxW: 512,
      });
    }
  }
  mkdirSync(join(process.cwd(), 'public', dirnameOf(session.scene)), { recursive: true });
  const spec = JSON.stringify(files.map((f) => ({ src: f.src, dest: f.dest, maxW: f.maxW })));
  const py = `
import json, sys
from PIL import Image
spec = json.loads(sys.argv[1])
budget = int(sys.argv[2])
for quality in (80, 70, 60, 50, 40, 30):
    total = 0
    for item in spec:
        im = Image.open(item["src"]).convert("RGB")
        if im.width > item["maxW"]:
            im = im.resize((item["maxW"], round(im.height * item["maxW"] / im.width)), Image.LANCZOS)
        im.save(item["dest"], "WEBP", quality=quality, method=6)
    import os
    total = sum(os.path.getsize(item["dest"]) for item in spec)
    print(f"quality {quality}: total {total} bytes")
    if total <= budget:
        break
else:
    sys.exit("over budget at quality 30")
`;
  try {
    const out = execFileSync('python3', ['-c', py, spec, String(SIZE_BUDGET_BYTES)], { encoding: 'utf8' });
    console.log(out.trim());
  } catch (err) {
    throw new Error(`Compression failed: ${(err as Error).message}`);
  }
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyAll = args.filter((a, i) => args[i - 1] === '--only');
  const only = onlyAll.length > 0 ? onlyAll : null;
  const samOnly = args.includes('--sam');
  const finalizeOnly = args.includes('--finalize');
  const handFile = args.includes('--hand') ? args[args.indexOf('--hand') + 1] : null;
  const keepArg = args.includes('--keep') ? args[args.indexOf('--keep') + 1] : '';
  const keep: Record<string, number> = {};
  if (keepArg) {
    for (const pair of keepArg.split(',')) {
      const [pic, n] = pair.split('=');
      if (pic && n) keep[pic.trim()] = Number(n);
    }
  }
  const sessionFile = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
  const scenePrompt = args.includes('--scene-prompt') ? args[args.indexOf('--scene-prompt') + 1] : null;

  if (handFile) {
    writeHandBoxes(handFile);
    return;
  }

  const env = loadEnv();
  const key = requireModelApiKey(env);

  if (sessionFile) {
    await runRoleSession({
      key,
      file: sessionFile,
      only,
      scenePrompt,
      keep,
      finalizeOnly,
    });
    return;
  }

  if (finalizeOnly) {
    finalize(keep);
    return;
  }
  if (samOnly) {
    await runSam(key);
    return;
  }

  const pics = only ?? ['classroom', 'maya', 'leo', 'priya', 'sam'];
  for (const pic of pics) {
    if (!['classroom', 'maya', 'leo', 'priya', 'sam'].includes(pic)) {
      throw new Error(`Unknown picture --only ${pic}; use classroom|maya|leo|priya|sam.`);
    }
  }
  if (pics.includes('classroom')) {
    await generatePicture({
      key,
      pic: 'classroom',
      prompt: CLASSROOM_PROMPT,
      referenceB64: null,
      size: '1536x1024',
    });
  }
  const portraits = pics.filter((p) => p !== 'classroom');
  if (portraits.length > 0) {
    const ref = latestCandidate('classroom', keep.classroom ?? null);
    const refB64 = readFileSync(ref).toString('base64');
    for (const id of portraits) {
      const student = CAST.find((s) => s.id === id);
      if (!student) throw new Error(`Unknown student ${id}`);
      await generatePicture({
        key,
        pic: id,
        prompt: portraitPrompt(student.name, student.description),
        referenceB64: refB64,
        size: '1024x1024',
      });
    }
  }
  const ledger = loadLedger();
  console.log(
    `Ledger: ${ledger.imageCalls} image calls total, attempts ${JSON.stringify(ledger.attempts)}. ` +
      `Rough image spend: $${(ledger.imageCalls * 0.01).toFixed(2)} (billed only for returned images, $0.01 each).`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Status only; never the key or request bodies.
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
