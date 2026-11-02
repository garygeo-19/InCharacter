import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Owner phone-test fixes (Nov 2026), mocked APIs at 390 × 844:
// the Atomic Habits row counts ready content across roles ("Coach a client
// ready") and its pack screen leads with the coach tile; after Done in a
// session the You bubble keeps the typed reply during "thinking" and the
// compact history shows it on the next turn. Timers run short via ?fast=1.
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

const ATOMIC_PARTS = {
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

const EMPTY_PARTS = {
  packId: 'national-parks',
  packVersion: '1.0.0',
  lessons: [{
    id: 'l1',
    title: 'Lesson 1',
    parts: [{
      id: 'p1', title: 'Part 1: Geysers',
      blurb: 'Hot water, high pressure.',
      noteCount: 4, teachable: true, ready: false, usableByDifficulty: [0, 0, 0],
    }],
  }],
};

function sessionDisplay() {
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
      audioUrl: null,
    })),
  };
}

async function mockApi(page: Page, turnDelayMs: number) {
  // The empty pack is listed first: anything ready must still sort first.
  await page.route('**/api/catalog', (r) => r.fulfill({
    json: {
      packs: [
        { id: 'national-parks', name: 'National Parks', icon: '🏞️', version: '1.0.0', language: 'en', lessonCount: 1, cardCount: 4 },
        { id: 'atomic-habits', name: 'Atomic Habits', icon: '🌱', version: '1.0.0', language: 'en', lessonCount: 1, cardCount: 9 },
      ],
    },
  }));
  await page.route('**/api/parts/*', (r) => r.fulfill({
    json: r.request().url().includes('atomic-habits') ? ATOMIC_PARTS : EMPTY_PARTS,
  }));
  await page.route('**/api/pack/*', (r) => r.fulfill({ json: PACK_JSON }));
  await page.route('**/api/session/**', (r) => r.fulfill({ json: sessionDisplay() }));
  const turns: Record<string, { next: string; route: string }> = {
    open: { next: 'open-push', route: 'missed' },
    'open-push': { next: 'stage2', route: 'on' },
    stage2: { next: 'close-good', route: 'applied' },
  };
  await page.route('**/api/turn', async (r) => {
    // Hold the thinking beat open so the reply-on-screen state is observable.
    await new Promise((res) => setTimeout(res, turnDelayMs));
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
      ],
      dropped: 0,
    },
  }));
}

test('Atomic Habits row names its ready role; its pack screen leads with the coach tile', async ({ page }) => {
  await mockApi(page, 0);
  await page.goto('/?fast=1');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible();

  // The row counts everything ready across roles — not "coming soon".
  const row = page.getByRole('button', { name: /Atomic Habits/ });
  await expect(row).toContainText('Coach a client ready', { timeout: 10000 });
  // The pack with anything ready sorts before the pack with nothing ready.
  await expect(page.locator('.pack-list .pack-row').first()).toContainText('Atomic Habits');
  await expect(page.getByRole('button', { name: /National Parks/ })).toContainText('Classes coming soon');

  await row.click();
  // The ready coach tile leads; Teach a class sits after it, muted.
  const tiles = page.locator('.tile');
  await expect(tiles.nth(0)).toContainText('Coach a client', { timeout: 10000 });
  await expect(tiles.nth(0)).toContainText('1 session ready');
  await expect(tiles.nth(1)).toContainText('Teach a class');
  await expect(tiles.nth(1)).toContainText('Coming soon');
});

test('after Done the You bubble keeps the reply while thinking; history shows it next turn', async ({ page }) => {
  await mockApi(page, 800);
  await page.goto('/?fast=1');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible();
  await page.getByRole('button', { name: /Atomic Habits/ }).click();
  await page.getByRole('button', { name: /Coach a client/ }).click();
  await expect(page.getByRole('heading', { name: 'Coach a client' })).toBeVisible();
  await page.getByRole('button', { name: /The Two-Minute Rule/ }).click();
  await expect(page.getByText(/Your client: Alex/)).toBeVisible();
  await page.getByRole('button', { name: 'Start session' }).click();

  await expect(page.getByText('I keep telling myself')).toBeVisible({ timeout: 10000 });
  const reply = 'I will read just one page before bed.';
  await page.getByPlaceholder('Type your reply — write as much as you like').fill(reply);
  await page.getByRole('button', { name: 'Done' }).click();

  // While Alex is thinking, the learner's own words stay on screen in a
  // "You" bubble under the character's line.
  await expect(page.getByText('Alex is thinking…')).toBeVisible({ timeout: 10000 });
  const you = page.locator('.bubble.you', { hasText: reply });
  await expect(you).toBeVisible({ timeout: 10000 });
  await expect(you.locator('.asker')).toHaveText('You');

  // On the next turn the conversation so far is a compact history above
  // the current line, with the reply still under Alex's opener.
  await expect(page.getByText("Isn't small stuff pointless?")).toBeVisible({ timeout: 15000 });
  const history = page.getByRole('region', { name: 'Earlier in this session' });
  await expect(history).toBeVisible({ timeout: 10000 });
  await expect(history).toContainText(reply);
});
