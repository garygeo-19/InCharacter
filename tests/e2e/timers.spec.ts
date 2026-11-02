import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Owner bug 31 Oct 2026: after Done the answer timer kept counting down
// while the answer transcribed. Done (voice) must stop the timer at once
// and show it stopped ("Answer sent" + waiting dots); End class follows
// the same rule. Both specs wait for stable end states, never for
// mid-count timer values.

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
    const w = window as unknown as { __gumCalls?: number; __fakeCtx?: AudioContext };
    w.__gumCalls = 0;
    const devices = navigator.mediaDevices ?? ({} as Navigator['mediaDevices']);
    try {
      Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true });
    } catch {
      // Already defined.
    }
    devices.getUserMedia = (async () => {
      w.__gumCalls = (w.__gumCalls ?? 0) + 1;
      const AC = window.AudioContext;
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
      // Storage unavailable.
    }
  });
}

async function mockApi(page: Page, delayMs: (call: number) => number) {
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
  await page.route('**/api/transcribe', async (r) => {
    calls += 1;
    const ms = delayMs(calls);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    await r.fulfill({ status: 200, json: VOICE_LINES });
  });
}

async function driveToClass(page: Page) {
  await page.goto('/?fast=1');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Spanish: Food & Shopping/ }).click();
  await page.getByRole('button', { name: /Teach a class/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose a class' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /At the Restaurant/ }).click();
  await expect(page.getByText("You're the Spanish teacher.")).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Start class' }).click();
}

async function frozenTimer(page: Page): Promise<[string, string]> {
  const timer = page.locator('.timer');
  const first = await timer.textContent();
  // Longer than one 1 s tick: a running timer must change, a stopped one cannot.
  await page.waitForTimeout(1600);
  const second = await timer.textContent();
  return [first ?? '', second ?? ''];
}

test('Done stops the answer timer and shows Transcribing in your reply bubble', async ({ page }) => {
  await fakeMic(page);
  // Class transcribes at once; the first answer takes 2.5 s so the
  // stopped timer is observable before the next question lands.
  await mockApi(page, (call) => (call === 2 ? 2500 : 0));
  await driveToClass(page);
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });

  const endBtn = page.getByRole('button', { name: 'End class' });
  await expect(endBtn).toBeEnabled({ timeout: 15000 });
  await endBtn.click();
  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 15000 });

  // The answer auto-records when the question audio ends or falls back.
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });
  const done = page.getByRole('button', { name: 'Done' });
  await expect(done).toBeEnabled({ timeout: 10000 });
  // Let the 8 s answer timer tick so a frozen display proves the fix.
  // (The auto-recorded answer starts once the question audio ends or the
  // caption falls back, so allow past that before the first tick.)
  await page.waitForFunction(
    () => document.querySelector('.timer')?.textContent !== '0:08',
    { timeout: 20000 },
  );
  await done.click();

  // The stopped state: frozen timer, disabled Done, waiting dots.
  await expect(page.getByRole('status').filter({ hasText: 'Transcribing…' }).first()).toBeAttached({ timeout: 10000 });
  await expect(done).toBeDisabled({ timeout: 10000 });
  const [before, after] = await frozenTimer(page);
  expect(after).toBe(before);

  // Exactly one submit: the next question lands once, with a fresh timer.
  await expect(page.getByText('Question 2 of 3.')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.levelbar-pinned')).toHaveCount(0);
});

test('End class stops the class timer and shows Class sent while transcribing', async ({ page }) => {
  await fakeMic(page);
  // The class transcription takes 2.5 s so the stopped timer is observable.
  await mockApi(page, (call) => (call === 1 ? 2500 : 0));
  await driveToClass(page);
  await expect(page.locator('.levelbar-pinned')).toBeVisible({ timeout: 15000 });

  const endBtn = page.getByRole('button', { name: 'End class' });
  await expect(endBtn).toBeEnabled({ timeout: 15000 });
  await endBtn.click();

  await expect(page.getByText('Class sent…')).toBeVisible({ timeout: 10000 });
  await expect(endBtn).toBeDisabled({ timeout: 10000 });
  const [before, after] = await frozenTimer(page);
  expect(after).toBe(before);

  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 15000 });
});
