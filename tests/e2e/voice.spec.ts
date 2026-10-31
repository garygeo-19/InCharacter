import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Voice mode end to end at 390 × 844 (§13) with the model calls mocked and
// the mic faked: getUserMedia returns an oscillator-driven MediaStream, so
// the real AudioWorklet capture path runs without a microphone. Voice mode
// is seeded through localStorage (ic-settings) to skip the briefing mic
// check; timers run short via ?fast=1.
//
// Covers owner feedback 31 Oct 2026: the pinned level bar, answers that
// auto-record when the question audio ends (caption fallback 2 s after it
// appears), and readable transcribe errors whose "Try again" re-sends the
// kept audio.

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

const VOICE_LINES = {
  lines: [{ n: 1, text: 'La propina is the tip and la cuenta is the bill.', source: 'voice' }],
  audioDurationMs: 1200,
};

async function fakeMic(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __gumCalls?: number;
      __fakeCtx?: AudioContext;
      AudioContext: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    w.__gumCalls = 0;
    const devices = navigator.mediaDevices ?? ({} as Navigator['mediaDevices']);
    try {
      Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true });
    } catch {
      // Already defined; assignment below still works where writable.
    }
    devices.getUserMedia = (async () => {
      w.__gumCalls = (w.__gumCalls ?? 0) + 1;
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
      w.__fakeCtx = ctx;
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

async function gumCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __gumCalls?: number }).__gumCalls ?? -1,
  );
}

async function mockApi(page: Page, onTranscribe: (call: number) => { status: number; json: unknown }) {
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
  const covered = (noteId: string, quote: string) => ({ noteId, verdict: 'covered', quote, why: 'mock' });
  const missed = (noteId: string) => ({ noteId, verdict: 'missed', quote: null, why: 'mock' });
  await page.route('**/api/grade/class', (r) => r.fulfill({
    json: {
      notes: [
        covered('pair-la-carta', 'menu is el menu'),
        covered('pair-la-cuenta', 'bill is la cuenta'),
        covered('pair-quisiera', 'say quisiera'),
        covered('fi-mcq-ordering-phrase', 'para mi el pollo'),
        missed('fact-buen-provecho'), missed('ih-paella-valenciana'),
        missed('fact-carta-not-menu'), missed('fi-ot-ask-bill'),
        missed('pair-el-camarero'), missed('pair-la-propina'),
      ],
      moves: [],
      dropped: 0,
    },
  }));
  await page.route('**/api/grade/answers', (r) => r.fulfill({
    json: {
      answers: [
        { questionId: 'q-propina-meaning', points: [{ index: 0, result: 'hit', quote: 'x' }], contradictions: [], empty: false },
        { questionId: 'q-getting-the-check', points: [{ index: 0, result: 'hit', quote: 'x' }, { index: 1, result: 'hit', quote: 'x' }], contradictions: [], empty: false },
        { questionId: 'q-paella-seafood', points: [{ index: 0, result: 'hit', quote: 'x' }, { index: 1, result: 'hit', quote: 'x' }], contradictions: [], empty: false },
      ],
      dropped: 0,
    },
  }));
  let calls = 0;
  await page.route('**/api/transcribe', (r) => {
    calls += 1;
    const { status, json } = onTranscribe(calls);
    void r.fulfill({ status, json });
  });
}

// Home → briefing → class screen in voice mode (?fast=1: 12 s class, 2 s
// before End class enables, 8 s answers).
async function driveToClass(page: Page) {
  await page.goto('/?fast=1');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible();
  await page.getByRole('button', { name: /Spanish: Food & Shopping/ }).click();
  await page.getByRole('button', { name: /Teach a class/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose a class' })).toBeVisible();
  await page.getByRole('button', { name: /At the Restaurant/ }).click();
  await expect(page.getByText("You're the Spanish teacher.")).toBeVisible();
  await page.getByRole('button', { name: 'Start class' }).click();
}

async function endClass(page: Page) {
  const endBtn = page.getByRole('button', { name: 'End class' });
  await expect(endBtn).toBeEnabled({ timeout: 15000 });
  await endBtn.click();
}

test('pinned level bar stays on screen; answers auto-record when the question ends', async ({ page }) => {
  await fakeMic(page);
  await mockApi(page, () => ({ status: 200, json: VOICE_LINES }));
  await driveToClass(page);

  // The class auto-records as before, now with the pinned bar.
  const bar = page.locator('.levelbar-pinned');
  await expect(bar).toBeVisible({ timeout: 15000 });
  const position = await page.evaluate(
    () => getComputedStyle(document.querySelector('.levelbar-pinned')!).position,
  );
  expect(position).toBe('fixed');
  // One live region announces Recording once; the moving fill is silent.
  await expect(bar.locator('[role="status"]')).toHaveText('Recording', { timeout: 15000 });
  expect(await bar.locator('.levelbar-track[aria-hidden="true"]').count()).toBe(1);

  // Scroll the outline to the bottom: the bar stays pinned near the top.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const box = await bar.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThan(60);
  const vp = page.viewportSize()!;
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);

  await endClass(page);
  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 15000 });

  // Auto-record: no Start button; the answer records on its own once the
  // question audio ends (or 2 s after the caption on fallback), with the
  // full timer and a "Your turn" cue.
  await expect(page.getByRole('button', { name: 'Start answer' })).toHaveCount(0);
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Your turn — speak now.')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Done' })).toBeEnabled({ timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelector('.timer')?.textContent !== '0:08',
    { timeout: 15000 },
  );
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByText('Question 2 of 3.')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.levelbar-pinned')).toHaveCount(0);
});

test('transcribe failure reads plainly; Try again re-sends the kept audio', async ({ page }) => {
  await fakeMic(page);
  // Call 1 (class) succeeds, call 2 (answer 1) fails, call 3+ succeed.
  await mockApi(page, (call) =>
    call === 2
      ? { status: 502, json: { error: 'Transcription failed with status 500: model overloaded' } }
      : { status: 200, json: VOICE_LINES },
  );
  await driveToClass(page);
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  await endClass(page);
  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 15000 });

  // The answer auto-records; Done ends it.
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Done' }).click();

  // Plain words, not the raw status — with both recovery actions.
  const error = page.locator('.error');
  await expect(error).toBeVisible({ timeout: 15000 });
  await expect(error).toContainText(/didn't transcribe/i);
  await expect(error).not.toContainText(/request failed/i);
  await expect(error).not.toContainText(/status 500/i);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Type it instead' })).toBeVisible({ timeout: 10000 });

  // Try again re-sends the kept WAV: the mic is not re-opened.
  const before = await gumCalls(page);
  expect(before).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Question 2 of 3.')).toBeVisible({ timeout: 15000 });
  expect(await gumCalls(page)).toBe(before);
});

test('transcribe failure offers Type it instead', async ({ page }) => {
  await fakeMic(page);
  // The class transcribes; the first answer never does.
  await mockApi(page, (call) =>
    call === 1
      ? { status: 200, json: VOICE_LINES }
      : { status: 502, json: { error: 'Transcription failed with status 500: model overloaded' } },
  );
  await driveToClass(page);
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  await endClass(page);
  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 15000 });

  // The answer auto-records; Done ends it.
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.error')).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: 'Type it instead' }).click();
  const answerBox = page.getByPlaceholder('Type your answer — write as much as you like');
  await expect(answerBox).toBeVisible({ timeout: 10000 });
  await answerBox.fill('La propina is the tip.');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Question 2 of 3.')).toBeVisible({ timeout: 15000 });
});

test('reduced motion shows a still bar with a numeric level', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fakeMic(page);
  await mockApi(page, () => ({ status: 200, json: VOICE_LINES }));
  await driveToClass(page);
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });

  await endClass(page);
  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 15000 });
  // The answer auto-records once the question audio ends or falls back.
  // Steady red fill plus a numeric level snapped twice a second. The number
  // arrives with the first level callback, so wait for that stable state.
  await expect(page.locator('.levelbar-fill.still')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.levelbar-num')).toContainText(/Mic level \d+%/, { timeout: 15000 });
});
