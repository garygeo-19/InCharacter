import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Temporary M5 audit (deleted before commit): layout overflow + tap
// targets + keyboard peek at 360×800, 390×844 and 1280×800 (§11.3, §12 M5).

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

async function noOverflow(page: Page, stage: string) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(wide, `${stage}: horizontal overflow ${wide}px`).toBeLessThanOrEqual(1);
}

async function tapTargets(page: Page, stage: string) {
  const small = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll('button, input, select, summary, a')) {
      if (el instanceof HTMLInputElement && el.type === 'checkbox') continue;
      if (!(el instanceof HTMLElement) || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 44) bad.push(`${el.tagName} ${el.textContent?.trim().slice(0, 30)} h=${Math.round(r.height)}`);
    }
    return bad;
  });
  expect(small, `${stage}: small targets ${JSON.stringify(small)}`).toEqual([]);
}

for (const vp of [{ w: 360, h: 800 }, { w: 390, h: 844 }, { w: 1280, h: 800 }]) {
  test(`audit at ${vp.w}x${vp.h}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await mockApi(page);
    await page.goto('/?fast=1');

    await expect(page.getByRole('heading', { name: 'Teach it to learn it.' })).toBeVisible();
    await noOverflow(page, 'home');
    await tapTargets(page, 'home');

    // Settings sheet: dialog semantics, Escape, focus return.
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Settings');

    await page.getByRole('button', { name: /Spanish: Food & Shopping/ }).click();
    await page.getByRole('button', { name: /Teach a class/ }).click();
    await expect(page.getByRole('heading', { name: 'Choose a class' })).toBeVisible();
    await noOverflow(page, 'list');
    await page.getByRole('button', { name: /At the Restaurant/ }).click();
    await expect(page.getByText("You're the Spanish teacher.")).toBeVisible();
    await noOverflow(page, 'briefing');
    await tapTargets(page, 'briefing');
    await page.getByRole('button', { name: 'Start class' }).click();

    const classBox = page.getByPlaceholder('Teach your class, one message per line');
    await expect(classBox).toBeVisible({ timeout: 10000 });
    await noOverflow(page, 'class');
    await tapTargets(page, 'class');
    const live = page.locator('.sr-only[aria-live="polite"]');
    await expect(live).toHaveCount(1);

    // Keyboard peek: tab to the first outline row, hold Space past 300 ms.
    const peek = page.locator('.peek-row').first();
    await peek.focus();
    await expect(peek).toBeFocused();
    await page.keyboard.down('Space');
    await page.waitForTimeout(600);
    await expect(peek).toHaveAttribute('aria-expanded', 'true');
    await expect(peek.locator('.peek-text')).toBeVisible();
    await page.keyboard.up('Space');
    await expect(peek).toHaveAttribute('aria-expanded', 'false');

    await classBox.fill('The menu is el menú and the bill is la cuenta.');
    await page.getByRole('button', { name: 'Send' }).click();
    await classBox.fill('To order say quisiera and para mí el pollo.');
    await page.getByRole('button', { name: 'Send' }).click();
    const endBtn = page.getByRole('button', { name: 'End class' });
    await expect(endBtn).toBeEnabled({ timeout: 10000 });
    await endBtn.click();

    await expect(page.getByText('Hands are going up…')).toBeVisible();
    for (const [i, answer] of [
      'La propina is the tip.',
      'Ask la cuenta por favor, they will not bring it.',
      'Rabbit not seafood, saffron rice with chicken and beans.',
    ].entries()) {
      await expect(page.getByRole('heading', { name: `Question ${i + 1} of 3.` })).toBeVisible({ timeout: 15000 });
      await noOverflow(page, `question${i + 1}`);
      const answerBox = page.getByPlaceholder('Type your answer');
      await expect(answerBox).toBeVisible({ timeout: 10000 });
      await answerBox.fill(answer);
      await page.getByRole('button', { name: 'Done' }).click();
    }

    await expect(page.getByText('Grading your class…')).toBeVisible();
    await expect(page.getByRole('heading', { name: '63 / 100' })).toBeVisible({ timeout: 15000 });
    await noOverflow(page, 'debrief');
    await tapTargets(page, 'debrief');
  });
}
