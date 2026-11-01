import { expect, test, type Page } from '@playwright/test';

// The walking map (§16.6, mocked APIs, travel session): the map shows the
// start pin, the dot walks after a turn, and the station pin appears only
// at the end. Not run here (no browsers in this environment); the reviewer
// runs Playwright.

const PACK_JSON = {
  packId: 'spanish-travel-lodging',
  packName: 'Spanish: Travel & Lodging',
  packVersion: '1.0.7',
  language: 'es',
  lessons: [{
    id: 'l5-travel', title: 'Lesson 5', order: 0,
    parts: [{
      id: 'p14-asking-directions', title: 'Part 14: Asking Directions',
      blurb: 'Find your way.',
      itemIds: ['pair-derecha'],
    }],
    objectives: [],
  }],
  items: [
    {
      id: 'pair-derecha', shape: 'pair',
      sideA: { modality: 'text', value: 'la derecha' },
      sideB: { modality: 'text', value: 'to the right' },
    },
  ],
};

const PARTS_JSON = {
  packId: 'spanish-travel-lodging',
  packVersion: '1.0.7',
  lessons: [{
    id: 'l5-travel',
    title: 'Lesson 5',
    parts: [{
      id: 'p14-asking-directions', title: 'Part 14: Asking Directions',
      blurb: 'Find your way.',
      noteCount: 1, teachable: true, ready: false, usableByDifficulty: [0, 0, 0],
      sessions: { coach: false, travel: true },
    }],
  }],
};

const SESSION_JSON = {
  role: 'travel',
  brief: 'Ask the way to the station before the last bus leaves.',
  cast: [
    { id: 'lucia', name: 'Doña Lucía', description: 'Older woman', portrait: 'art/travel/lucia.webp' },
    { id: 'pablo', name: 'Don Pablo', description: 'Middle-aged man', portrait: 'art/travel/pablo.webp' },
    { id: 'jorge', name: 'Jorge', description: 'Station clerk', portrait: 'art/travel/jorge.webp' },
  ],
  scene: 'art/travel/scene.webp',
  start: 'lucia-1',
  map: { start: 'Plaza', goal: 'Estación' },
  nodes: [
    {
      id: 'lucia-1', speaker: 'lucia', text: 'Dobla a la derecha en la esquina.',
      gloss: 'Turn right at the corner.', scene: 'art/travel/scene.webp',
      reply: true, end: false, noteIds: ['pair-derecha'],
      expectedPoints: [{ text: 'Say you will turn right', noteIds: ['pair-derecha'] }],
      routes: [{ id: 'lucia-right', moves: [{ turn: 'right', blocks: 3 }] }],
      audioUrl: null,
    },
    {
      id: 'pablo-2', speaker: 'pablo', text: 'Todo derecho dos cuadras.',
      gloss: 'Straight ahead two blocks.', scene: 'art/travel/scene.webp',
      reply: true, end: false, noteIds: ['pair-derecha'],
      expectedPoints: [{ text: 'Say you will go straight', noteIds: ['pair-derecha'] }],
      routes: [{
        id: 'pablo-on',
        moves: [{ turn: 'none', blocks: 2 }, { turn: 'left', blocks: 1 }],
      }],
      audioUrl: null,
    },
    {
      id: 'arrive', speaker: 'jorge', text: '¡Aquí está la estación!',
      gloss: 'Here is the station!', scene: 'art/travel/scene.webp',
      reply: false, end: true, noteIds: [],
      expectedPoints: [],
      routes: [],
      audioUrl: null,
    },
  ],
};

async function mockApi(page: Page) {
  await page.route('**/api/catalog', (r) => r.fulfill({
    json: {
      packs: [
        {
          id: 'spanish-travel-lodging', name: 'Spanish: Travel & Lodging',
          icon: '🧭', version: '1.0.7', language: 'es', lessonCount: 1, cardCount: 1,
        },
      ],
    },
  }));
  await page.route('**/api/parts/*', (r) => r.fulfill({ json: PARTS_JSON }));
  await page.route('**/api/pack/*', (r) => r.fulfill({ json: PACK_JSON }));
  await page.route('**/api/session/**', (r) => r.fulfill({ json: SESSION_JSON }));
  const turns: Record<string, { next: string; route: string }> = {
    'lucia-1': { next: 'pablo-2', route: 'lucia-right' },
    'pablo-2': { next: 'arrive', route: 'pablo-on' },
  };
  await page.route('**/api/turn', async (r) => {
    const body = (r.request().postDataJSON?.() ?? {}) as { nodeId: string };
    const t = turns[body.nodeId] ?? { next: 'arrive', route: 'default' };
    await r.fulfill({ json: { ...t, source: 'model' } });
  });
  await page.route('**/api/grade/session', (r) => r.fulfill({
    json: {
      answers: [
        {
          nodeId: 'lucia-1',
          points: [{ index: 0, result: 'hit', quote: 'doblo a la derecha' }],
          contradictions: [],
          empty: false,
        },
        {
          nodeId: 'pablo-2',
          points: [{ index: 0, result: 'hit', quote: 'sigo todo derecho' }],
          contradictions: [],
          empty: false,
        },
      ],
      dropped: 0,
    },
  }));
}

async function dotPos(page: Page): Promise<string> {
  const dot = page.locator('[data-testid="map-you"] circle').nth(1);
  return `${await dot.getAttribute('cx')},${await dot.getAttribute('cy')}`;
}

test('the walking map draws the trail from what the traveler says', async ({ page }) => {
  await mockApi(page);
  await page.goto('/?fast=1');
  await expect(page.getByRole('heading', { name: 'Experience it to learn it.' })).toBeVisible();
  await page.getByRole('button', { name: /Travel & Lodging/ }).click();
  await page.getByRole('button', { name: /Find your way/ }).click();
  await expect(page.getByRole('heading', { name: 'Find your way' })).toBeVisible();
  await page.getByRole('button', { name: /Asking Directions/ }).click();
  await expect(page.getByText(/Ask the way to the station/)).toBeVisible();
  await page.getByRole('button', { name: 'Start session' }).click();

  // Turn 1: the map shows the start pin and the dot, but no station pin —
  // the map never gives the goal away before arrival.
  await expect(page.getByText('Dobla a la derecha en la esquina.')).toBeVisible({ timeout: 10000 });
  const map = page.getByTestId('town-map');
  await expect(map).toBeVisible({ timeout: 10000 });
  await expect(map).toHaveAttribute('role', 'img');
  await expect(page.getByTestId('map-start')).toBeVisible();
  await expect(page.getByTestId('map-you')).toBeVisible();
  await expect(page.getByTestId('map-goal')).toHaveCount(0);
  await expect(map).toHaveAttribute('aria-label', /You stayed where you started/);
  // The English gloss stays behind its peek, as before.
  await expect(page.getByRole('button', { name: /Show English/ })).toBeVisible();
  const before = await dotPos(page);

  // Answer: the game master routes right 3 blocks, and the dot walks there.
  await expect(page.getByPlaceholder('Type your reply — write as much as you like')).toBeVisible({ timeout: 10000 });
  await page.getByPlaceholder('Type your reply — write as much as you like').fill('Doblo a la derecha.');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Todo derecho dos cuadras.')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('map-pin-lucia')).toBeVisible();
  await expect(page.getByTestId('map-goal')).toHaveCount(0);
  await expect
    .poll(() => dotPos(page), { timeout: 10000 })
    .not.toBe(before);
  await expect(map).toHaveAttribute('aria-label', /You walked right 3 blocks/);

  // Walk on to the station: the goal pin appears only on arrival.
  await page.getByPlaceholder('Type your reply — write as much as you like').fill('Sigo todo derecho.');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('¡Aquí está la estación!')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('map-goal')).toBeVisible({ timeout: 10000 });
  await expect(map).toHaveAttribute('aria-label', /reached Estación/);

  // Debrief: the full map with the whole trail and the station.
  await expect(page.getByRole('heading', { name: 'Your walk' })).toBeVisible({ timeout: 15000 });
  const debriefMap = page.getByRole('region', { name: 'Your walk' }).getByTestId('town-map');
  await expect(debriefMap).toBeVisible();
  await expect(debriefMap).toHaveAttribute('aria-label', /right 3 blocks.*straight 2 and left 1.*reached Estación/);
  await expect(page.getByRole('region', { name: 'Your walk' }).getByTestId('map-goal')).toBeVisible();
});
