import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Roles end to end at 390 × 844 (§16, mobile project, mocked APIs):
// the atomic-habits pack shows "Coach a client"; a Type-mode coach session
// runs start → turns → a pushback branch → end → debrief with a quote; and
// a voice turn auto-starts after the audio. Timers run short via ?fast=1.
// Not run here (no browsers in this environment); the reviewer runs
// Playwright.

const FIXTURE = JSON.parse(
  readFileSync('tests/fixtures/sessions/atomic-habits/part-8.json', 'utf8'),
) as {
  brief: string;
  cast: { id: string; name: string; description: string; portrait: string }[];
  scene: string;
  start: string;
  nodes: {
    id: string; speaker: string; text: string; gloss: string | null;
    scene: string | null; reply: boolean; end: boolean; noteIds: string[];
    expectedPoints: { text: string; noteIds: string[] }[];
    routes: { id: string; when: string; next: string }[];
  }[];
};

const F1 = 'Start a new habit by scaling it down to a version that takes less than two minutes: read one page, put on running shoes, practice guitar for two minutes.';
const F2 = 'Reduce friction for good habits: lay out workout clothes the night before and keep the guitar on its stand, not in its case.';
const F3 = 'Lock in future behavior now: book a non-refundable class or agree to send a friend a photo of your running shoes each morning.';

const PACK_JSON = {
  packId: 'atomic-habits',
  packName: 'Atomic Habits',
  packVersion: '1.0.0',
  language: 'en',
  lessons: [{
    id: 'l8-commitment', title: 'Lesson 8', order: 0,
    parts: [{
      id: 'part-8', title: 'Part 8: The Two-Minute Rule',
      blurb: 'Small habits that stick.',
      itemIds: ['ah-p8-f1', 'ah-p8-f2', 'ah-p8-f3'],
    }],
    objectives: [],
  }],
  items: [
    { id: 'ah-p8-f1', shape: 'fact', title: 'The Two-Minute Rule', body: F1 },
    { id: 'ah-p8-f2', shape: 'fact', title: 'Make It Easy', body: F2 },
    { id: 'ah-p8-f3', shape: 'fact', title: 'Commitment Devices', body: F3 },
  ],
};

const PARTS_JSON = {
  packId: 'atomic-habits',
  packVersion: '1.0.0',
  lessons: [{
    id: 'l8-commitment',
    title: 'Lesson 8',
    parts: [{
      id: 'part-8', title: 'Part 8: The Two-Minute Rule',
      blurb: 'Small habits that stick.',
      noteCount: 3, teachable: true, ready: false, usableByDifficulty: [0, 0, 0],
      sessions: { coach: true, travel: false },
    }],
  }],
};

function sessionDisplay(audio: boolean) {
  return {
    role: 'coach',
    brief: FIXTURE.brief,
    cast: FIXTURE.cast,
    scene: FIXTURE.scene,
    start: FIXTURE.start,
    nodes: FIXTURE.nodes.map((n) => ({
      id: n.id,
      speaker: n.speaker,
      text: n.text,
      gloss: n.gloss,
      scene: n.scene ?? FIXTURE.scene,
      reply: n.reply,
      end: n.end,
      noteIds: n.noteIds,
      expectedPoints: n.expectedPoints,
      routes: n.routes.map((r) => ({ id: r.id })),
      audioUrl: audio ? `/audio/atomic-habits/part-8/${n.id}.mp3` : null,
    })),
  };
}

async function mockApi(page: Page, audio: boolean) {
  await page.route('**/api/catalog', (r) => r.fulfill({
    json: {
      packs: [
        { id: 'atomic-habits', name: 'Atomic Habits', icon: '🌱', version: '1.0.0', language: 'en', lessonCount: 1, cardCount: 9 },
      ],
    },
  }));
  await page.route('**/api/parts/*', (r) => r.fulfill({ json: PARTS_JSON }));
  await page.route('**/api/pack/*', (r) => r.fulfill({ json: PACK_JSON }));
  await page.route('**/api/session/**', (r) => r.fulfill({ json: sessionDisplay(audio) }));
  // The pushback branch: the first reply misses, the rest apply.
  const turns: Record<string, { next: string; route: string }> = {
    open: { next: 'open-push', route: 'missed' },
    'open-push': { next: 'stage2', route: 'on' },
    stage2: { next: 'close-good', route: 'applied' },
  };
  await page.route('**/api/turn', async (r) => {
    const body = (r.request().postDataJSON?.() ?? {}) as { nodeId: string };
    const t = turns[body.nodeId] ?? { next: 'close-good', route: 'default' };
    await r.fulfill({ json: { ...t, source: 'model' } });
  });
  await page.route('**/api/grade/session', (r) => r.fulfill({
    json: {
      answers: [
        {
          nodeId: 'open',
          points: [{ index: 0, result: 'hit', quote: 'read just one page before bed' }],
          contradictions: [],
          empty: false,
        },
        {
          nodeId: 'open-push',
          points: [{ index: 0, result: 'hit', quote: 'small starts still count' }],
          contradictions: [],
          empty: false,
        },
        {
          nodeId: 'stage2',
          points: [
            { index: 0, result: 'hit', quote: 'lay your shoes out tonight' },
            { index: 1, result: 'hit', quote: 'text your sister a photo each morning' },
          ],
          contradictions: [],
          empty: false,
        },
      ],
      dropped: 0,
    },
  }));
}

async function driveToBriefing(page: Page) {
  await page.goto('/?fast=1');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible();
  await page.getByRole('button', { name: /Atomic Habits/ }).click();
  await page.getByRole('button', { name: /Coach a client/ }).click();
  await expect(page.getByRole('heading', { name: 'Coach a client' })).toBeVisible();
  await page.getByRole('button', { name: /The Two-Minute Rule/ }).click();
  await expect(page.getByText(/Your client: Alex/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
}

test('coach tile replaces coming soon; Type session runs pushback branch to a quoted debrief', async ({ page }) => {
  await mockApi(page, false);
  await driveToBriefing(page);
  await page.getByRole('button', { name: 'Start session' }).click();

  // Turn 1: Alex opens.
  await expect(page.getByText('I keep telling myself')).toBeVisible({ timeout: 10000 });
  const box = page.getByPlaceholder('Type your reply — write as much as you like');
  await expect(box).toBeVisible({ timeout: 10000 });
  await box.fill('I will read just one page before bed.');
  await page.getByRole('button', { name: 'Done' }).click();

  // The pushback branch: Alex resists instead of moving on.
  await expect(page.getByText("Isn't small stuff pointless?")).toBeVisible({ timeout: 15000 });
  await expect(page.getByPlaceholder('Type your reply — write as much as you like')).toBeVisible({ timeout: 10000 });
  await page.getByPlaceholder('Type your reply — write as much as you like').fill('Small starts still count.');
  await page.getByRole('button', { name: 'Done' }).click();

  // Stage 2, then the good ending and grading.
  await expect(page.getByText('running shoes live in the closet')).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Type your reply — write as much as you like').fill(
    'Lay your shoes out tonight and text your sister a photo each morning.',
  );
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('I think this might actually stick')).toBeVisible({ timeout: 15000 });

  // Debrief: all three replies hit, so 100 with three stars, every quote
  // shown, the strong-reply key listed, and the path taken.
  await expect(page.getByRole('heading', { name: 'Great session — Alex is on track!' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('100 / 100')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('blockquote', { hasText: 'read just one page before bed' })).toBeVisible();
  await expect(page.getByText('A strong reply covers:').first()).toBeVisible();

  // History is per part and per role: back home, the session is kept with
  // its own best score and a Play again action.
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Keep teaching')).toBeVisible();
  await expect(page.getByText('Best 100')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible();
});

// A 0.3 s silent WAV served for every line mp3, so the voice turn starts
// when the audio really ends (not on the caption fallback).
function silentWav(): Buffer {
  const samples = 2400;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

async function fakeMic(page: Page) {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices ?? ({} as Navigator['mediaDevices']);
    try {
      Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true });
    } catch {
      // Already defined; assignment below still works where writable.
    }
    devices.getUserMedia = (async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      void ctx.resume().catch(() => {});
      return dest.stream;
    }) as typeof devices.getUserMedia;
    try {
      localStorage.setItem(
        'ic-settings',
        JSON.stringify({ mode: 'voice', peekStyle: 'hold', sound: true }),
      );
    } catch {
      // Storage unavailable; the test falls back to Type mode assertions.
    }
  });
}

test('a voice turn auto-starts after the audio', async ({ page }) => {
  await fakeMic(page);
  await mockApi(page, true);
  await page.route('**/audio/**', (r) => r.fulfill({
    status: 200,
    contentType: 'audio/wav',
    body: silentWav(),
  }));
  await page.route('**/api/transcribe', (r) => r.fulfill({
    json: {
      lines: [{ n: 1, text: 'Read just one page tonight.', source: 'voice' }],
      audioDurationMs: 1200,
    },
  }));
  await driveToBriefing(page);
  await page.getByRole('button', { name: 'Start session' }).click();

  // The line plays from its audio with a Replay button; when it ends the
  // answer records on its own with the "Your turn" cue — no Start button.
  await expect(page.getByText('I keep telling myself')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Replay/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Start answer' })).toHaveCount(0);
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Your turn — speak now.')).toBeVisible({ timeout: 10000 });

  // Done transcribes the reply and the game master moves the session on.
  await expect(page.getByRole('button', { name: 'Done' })).toBeEnabled({ timeout: 10000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText("Isn't small stuff pointless?")).toBeVisible({ timeout: 15000 });
});
