import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Live captions (§4.5, §9.6 should) at 390 × 844 with the model calls
// mocked and the mic faked like voice.spec.ts. The class runs at full
// length (no ?fast=1) so the first ~20 s chunk transcribes mid-class;
// the mocked /api/transcribe answers each chunk with distinct text, so
// the caption area can be matched to the first chunk exactly.
//
// Covers the owner request 1 Nov 2026: chunk lines appear during the
// class in chunk order with no new API calls, and the "Live captions"
// setting (on by default) hides the area without touching transcription.

const DEMO = JSON.parse(readFileSync('tests/fixtures/demo-part.json', 'utf8')) as {
  packId: string; packVersion: string; language: string;
  lessonId: string; lessonTitle: string;
  part: { id: string; title: string; blurb?: string; itemIds: string[] };
  items: unknown[];
};
const SEED = JSON.parse(
  readFileSync('content/banks/spanish-food-shopping/p10-at-the-restaurant.json', 'utf8'),
) as {
  questions: {
    id: string; text: string; type: string; difficulty: number; studentId: string;
    noteIds: string[]; expectedPoints: { point: string; noteIds: string[] }[];
    misconception: string | null;
  }[];
};

const PACK_JSON = {
  packId: DEMO.packId, packName: 'Spanish: Food & Shopping', packVersion: DEMO.packVersion,
  language: DEMO.language,
  lessons: [{ id: DEMO.lessonId, title: DEMO.lessonTitle, order: 0, parts: [DEMO.part], objectives: [] }],
  items: DEMO.items,
};
const PARTS_JSON = {
  packId: DEMO.packId,
  packVersion: DEMO.packVersion,
  lessons: [{
    id: DEMO.lessonId,
    title: DEMO.lessonTitle,
    parts: [{
      id: 'p10-at-the-restaurant', title: 'Part 1: At the Restaurant',
      blurb: 'Order with confidence and master table etiquette.',
      noteCount: 10, teachable: true, ready: true, usableByDifficulty: [3, 4, 5],
    }],
  }],
};

// Each chunk call gets its own text, so the caption can be matched to the
// chunk that produced it. Chunk 1 (the first ~20 s) carries FIRST_TEXT.
const FIRST_TEXT = 'Chunk one says la propina is the tip.';
const LATER_TEXT = 'A later chunk mentions la cuenta.';

async function fakeMic(page: Page, settings: Record<string, unknown>) {
  await page.addInitScript((seed) => {
    const w = window as unknown as {
      AudioContext: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const devices = navigator.mediaDevices ?? ({} as Navigator['mediaDevices']);
    try {
      Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true });
    } catch {
      // Already defined; assignment below still works where writable.
    }
    devices.getUserMedia = (async () => {
      const AC = w.AudioContext ?? w.webkitAudioContext;
      const ctx = new AC();
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
      localStorage.setItem('ic-settings', JSON.stringify(seed));
    } catch {
      // Storage unavailable; the test falls back to Type mode assertions.
    }
  }, settings);
}

async function mockApi(page: Page) {
  await page.route('**/api/catalog', (r) => r.fulfill({
    json: { packs: [{ id: DEMO.packId, name: 'Spanish: Food & Shopping', icon: '🍽️', version: '1.0.9', language: 'es', lessonCount: 1, cardCount: 25 }] },
  }));
  await page.route('**/api/parts/*', (r) => r.fulfill({ json: PARTS_JSON }));
  await page.route('**/api/pack/*', (r) => r.fulfill({ json: PACK_JSON }));
  await page.route('**/api/bank/*', (r) => r.fulfill({
    json: {
      questions: SEED.questions.map((q) => ({
        id: q.id, text: q.text, type: q.type, difficulty: q.difficulty,
        studentId: q.studentId, noteIds: q.noteIds,
        expectedPoints: q.expectedPoints, misconception: q.misconception,
        audioUrl: `/audio/spanish-food-shopping/p10-at-the-restaurant/${q.id}.mp3`,
      })),
    },
  }));
  await page.route('**/api/pick', (r) => r.fulfill({
    json: {
      picks: [{ questionId: 'q-propina-meaning' }, { questionId: 'q-getting-the-check' }, { questionId: 'q-paella-seafood' }],
      source: 'model',
    },
  }));
  let calls = 0;
  await page.route('**/api/transcribe', (r) => {
    calls += 1;
    const text = calls === 1 ? FIRST_TEXT : LATER_TEXT;
    void r.fulfill({
      json: { lines: [{ n: 1, text, source: 'voice' }], audioDurationMs: 20000 },
    });
  });
}

// Home → briefing → class screen in voice mode at full length (3:00), so
// a ~20 s chunk returns while the class is still running.
async function driveToClass(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible();
  await page.getByRole('button', { name: /Spanish: Food & Shopping/ }).click();
  await page.getByRole('button', { name: /Teach a class/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose a class' })).toBeVisible();
  await page.getByRole('button', { name: /At the Restaurant/ }).click();
  await expect(page.getByText("You're the Spanish teacher.")).toBeVisible();
  await page.getByRole('button', { name: 'Start class' }).click();
}

test('caption area shows the first chunk text during the class (setting on by default)', async ({ page }) => {
  test.setTimeout(120_000);
  // No liveCaptions key: the default (on) must apply to stored settings
  // saved before the setting existed.
  await fakeMic(page, { mode: 'voice', peekStyle: 'hold', sound: true });
  await mockApi(page);
  await driveToClass(page);

  const region = page.getByRole('region', { name: 'Live captions' });
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  // Before the first chunk returns, the quiet hint shows.
  await expect(region).toBeVisible({ timeout: 15000 });
  await expect(region).toContainText('Captions appear about every 20 seconds.', { timeout: 15000 });

  // The first ~20 s chunk posts mid-class; the mocked transcribe answers
  // at once, so its text appears while the class is still running.
  await page.waitForResponse('**/api/transcribe', { timeout: 90000 });
  await expect(region).toContainText(FIRST_TEXT, { timeout: 15000 });
  // Still in the class: End class is far from firing on its own.
  await expect(page.locator('.levelbar-pinned')).toBeVisible();
});

test('caption area hides when the setting is off; transcription still runs', async ({ page }) => {
  test.setTimeout(120_000);
  await fakeMic(page, { mode: 'voice', peekStyle: 'hold', sound: true, liveCaptions: false });
  await mockApi(page);
  await driveToClass(page);

  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  const region = page.getByRole('region', { name: 'Live captions' });
  await expect(region).toHaveCount(0);

  // A chunk still transcribes in the background (no new calls are added or
  // removed by the setting), and the area stays hidden.
  await page.waitForResponse('**/api/transcribe', { timeout: 90000 });
  await expect(region).toHaveCount(0);
  await expect(page.getByText('Captions appear about every 20 seconds.')).toHaveCount(0);
  await expect(page.locator('.levelbar-pinned')).toBeVisible();
});
