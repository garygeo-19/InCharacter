import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// M1 text simulation end to end at 390 × 844 (§13): Home → debrief in Type
// mode with the model calls mocked. Timers run short via ?fast=1.
// Expected score: lesson 13.33 + questions 50 − peeks 0 = 63, one star,
// with the celebration headline and a breakdown that adds up to the total.

const DEMO = JSON.parse(readFileSync('tests/fixtures/demo-part.json', 'utf8')) as {
  packId: string; packName: string; packVersion: string; language: string;
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

async function mockAll(page: Page) {
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
}

async function driveToDebrief(page: Page) {
  await page.goto('/?fast=1');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible();
  await page.getByRole('button', { name: /Spanish: Food & Shopping/ }).click();
  await page.getByRole('button', { name: /Teach a class/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose a class' })).toBeVisible();
  await page.getByRole('button', { name: /At the Restaurant/ }).click();
  await expect(page.getByText("You're the Spanish teacher.")).toBeVisible();
  await page.getByRole('button', { name: 'Start class' }).click();

  const classBox = page.getByPlaceholder('Teach your class — write as much as you like');
  await expect(classBox).toBeVisible({ timeout: 10000 });
  await classBox.fill('The menu is el menú and the bill is la cuenta. To order say quisiera and para mí el pollo.');
  const endBtn = page.getByRole('button', { name: 'End class' });
  await expect(endBtn).toBeEnabled({ timeout: 10000 });
  await endBtn.click();

  // The choosing interstitial is transient: with mocked pick+grade it can
  // resolve before this line runs, so wait for the first question instead
  // of requiring the interstitial. (The 0:06 timer in the report is also
  // correct: ?fast=1 shortens the 2:00 typed answer budget to 8 s.)
  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 15000 });
  // Name tags replace the old box outlines: the asker reads in text with a
  // filled tag, never depending on box positions.
  await expect(page.getByText('Maya is asking')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.name-tag.is-asking')).toHaveText('Maya', { timeout: 10000 });
  for (const [i, answer] of [
    'La propina is the tip.',
    'Ask la cuenta por favor, they will not bring it.',
    'Rabbit not seafood, saffron rice with chicken and beans.',
  ].entries()) {
    await expect(page.getByText(`Question ${i + 1} of 3.`)).toBeVisible({ timeout: 15000 });
    const answerBox = page.getByPlaceholder('Type your answer — write as much as you like');
    await expect(answerBox).toBeVisible({ timeout: 10000 });
    await answerBox.fill(answer);
    await page.getByRole('button', { name: 'Done' }).click();
  }
}

test('question plays recorded audio with caption and Replay', async ({ page }) => {
  await mockAll(page);
  await page.goto('/?fast=1');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible();
  await page.getByRole('button', { name: /Spanish: Food & Shopping/ }).click();
  await page.getByRole('button', { name: /Teach a class/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose a class' })).toBeVisible();
  await page.getByRole('button', { name: /At the Restaurant/ }).click();
  await expect(page.getByText("You're the Spanish teacher.")).toBeVisible();
  await page.getByRole('button', { name: 'Start class' }).click();

  const classBox = page.getByPlaceholder('Teach your class — write as much as you like');
  await expect(classBox).toBeVisible({ timeout: 10000 });
  await classBox.fill('The menu is el menú and the bill is la cuenta.');
  const endBtn = page.getByRole('button', { name: 'End class' });
  await expect(endBtn).toBeEnabled({ timeout: 10000 });
  await endBtn.click();

  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 15000 });
  // The question view carries the mp3 on an audio element with a Replay
  // button; the caption is shown, and the M3 cut-line placeholder is gone.
  const audio = page.locator('.question audio');
  await expect(audio).toHaveAttribute('src', /q-propina-meaning\.mp3/, { timeout: 10000 });
  await expect(page.getByRole('button', { name: /Replay/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Student voices are being recorded')).toHaveCount(0);
  // Type mode: the answer box is usable at once, while the audio plays.
  const answerBox = page.getByPlaceholder('Type your answer — write as much as you like');
  await expect(answerBox).toBeVisible({ timeout: 10000 });
  // Replay restarts the sound and leaves the question in place.
  await page.getByRole('button', { name: /Replay/ }).click();
  await expect(page.getByText('Question 1 of 3.')).toBeVisible({ timeout: 10000 });
  await expect(answerBox).toBeVisible({ timeout: 10000 });
});

test('teach a class in Type mode, mocked grading', async ({ page }) => {
  await mockAll(page);
  await driveToDebrief(page);

  // Celebration for one star: the encouraging headline, the score counted
  // up to 63, then the breakdown, all read from the score object.
  // (Same transient-state race as choosing: with mocked grades the
  // "Grading your class…" screen can resolve before its assertion runs,
  // so wait for the headline directly.)
  await expect(page.getByRole('heading', { name: "Good effort — here's what to teach next time." })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('63 / 100')).toBeVisible({ timeout: 15000 });
  // The count-up finishes in about 1.4 s, dismissing its skip hint.
  await expect(page.getByText('Tap to skip.')).toBeHidden({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'How your score was calculated' })).toBeVisible();
  // The breakdown adds up: lesson 13.33 + questions 50 − peeks 0 = 63.
  await expect(page.getByText('Notes: 4 covered, 0 partly, 6 missed, 0 not quite right (5 of 15 weight → 13.33 of 40)')).toBeVisible();
  await expect(page.getByText('Teaching moves: none → 0 of 10')).toBeVisible();
  await expect(page.getByText('Lesson: 13.33 of 50')).toBeVisible();
  await expect(page.getByText('Question 1: 15 of 15')).toBeVisible();
  await expect(page.getByText('Question 3: 20 of 20')).toBeVisible();
  await expect(page.getByText('Questions: 50 of 50')).toBeVisible();
  await expect(page.getByText('Peeks: 0 peeks, 0.0s → no penalty')).toBeVisible();
  await expect(page.getByText('Total: 13.33 + 50 − 0 = 63')).toBeVisible();
  // Screen readers get the final headline and score announced once.
  await expect(page.getByRole('status')).toContainText("Good effort — here's what to teach next time. Your score is 63 out of 100.", { timeout: 15000 });
  await expect(page.getByText('Covered', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Keep going')).toBeVisible();
  await expect(page.getByText('Best 63')).toBeVisible();
});

test('debrief shows its final state at once under prefers-reduced-motion', async ({ page }) => {
  await mockAll(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await driveToDebrief(page);

  await expect(page.getByRole('heading', { name: "Good effort — here's what to teach next time." })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('63 / 100')).toBeVisible({ timeout: 15000 });
  // No count-up, no sparkle burst, no skip hint: fully still.
  await expect(page.locator('.spark')).toHaveCount(0);
  await expect(page.getByText('Tap to skip.')).toHaveCount(0);
  await expect(page.getByText('Total: 13.33 + 50 − 0 = 63')).toBeVisible();
});
