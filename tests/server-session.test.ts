import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { setSessionFiles } from '../src/server/content';
import { clearCacheForTests } from '../src/shared/notes';

// Session routes with the network and the model stubbed: the catalog and the
// Atomic Habits pack come from inline fixtures whose fact titles/bodies hash
// exactly to the fixture session's recorded note hashes, and the Meta API
// answers from a queue. No key or live fetch is needed.

const F1 = 'Start a new habit by scaling it down to a version that takes less than two minutes: read one page, put on running shoes, practice guitar for two minutes.';
const F2 = 'Reduce friction for good habits: lay out workout clothes the night before and keep the guitar on its stand, not in its case.';
const F3 = 'Lock in future behavior now: book a non-refundable class or agree to send a friend a photo of your running shoes each morning.';

const AH_PACK = {
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

const CATALOG_JSON = {
  catalogVersion: 1,
  packs: [{
    id: 'atomic-habits', name: 'Atomic Habits', version: '1.0.0',
    contentHash: 'sha256:x', language: 'en', url: '/packs/atomic-habits.json',
    lessonCount: 1, cardCount: 9, status: 'ga',
  }],
};

const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/sessions/atomic-habits/part-8.json'), 'utf8'),
);

// Model calls are answered through createApp's modelFetch injection (see
// createMetaClient): canned Chat Completions bodies from a queue. Catalog
// and pack loads use global fetch.
const modelState = { queue: [] as unknown[], calls: 0 };

async function modelFetch(): Promise<Response> {
  modelState.calls++;
  const next = modelState.queue.shift();
  if (next instanceof Error) throw next;
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(next) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function stubNetwork() {
  modelState.queue = [];
  modelState.calls = 0;
  setSessionFiles({ 'atomic-habits/part-8': FIXTURE });
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/packs/catalog.json')) return { ok: true, json: async () => CATALOG_JSON };
    if (u.endsWith('.json')) return { ok: true, json: async () => AH_PACK };
    throw new Error(`unstubbed fetch: ${u}`);
  });
}

function queueModel(...items: unknown[]) {
  modelState.queue.push(...items);
}

function testApp() {
  return createApp({ MODEL_API_KEY: 'test-key' }, { modelFetch: modelFetch as typeof fetch });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCacheForTests();
  setSessionFiles({});
});

const TURN = {
  packId: 'atomic-habits',
  partId: 'part-8',
  nodeId: 'open',
  lines: [{ n: 1, text: 'Read just one page tonight.' }],
  visited: [] as string[],
};

describe('session routes (stubbed pack, session and model)', () => {
  it('serves a usable session with audio URLs and never voiceId', async () => {
    stubNetwork();
    const app = testApp();
    const res = await app.request('/api/session/atomic-habits/part-8?role=coach');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      role: string; brief: string; start: string;
      cast: { id: string; name: string }[];
      nodes: { id: string; audioUrl: string | null; routes: { id: string }[] }[];
    };
    expect(body.role).toBe('coach');
    expect(body.start).toBe('open');
    expect(body.cast).toEqual([{ id: 'alex', name: 'Alex', description: expect.any(String), portrait: expect.any(String) }]);
    expect(body.nodes.map((n) => n.id)).toEqual(['open', 'open-push', 'stage2', 'close-good', 'close-unsure']);
    for (const n of body.nodes) expect(n.audioUrl).toBeNull();
    expect(JSON.stringify(body)).not.toContain('voiceId');
  });

  it('404s an unknown part and a wrong role', async () => {
    stubNetwork();
    const app = testApp();
    expect((await app.request('/api/session/atomic-habits/nope')).status).toBe(404);
    expect((await app.request('/api/session/atomic-habits/part-8?role=travel')).status).toBe(404);
  });

  it('routes a valid model answer to its node', async () => {
    stubNetwork();
    queueModel({ route: 'applied' });
    const app = testApp();
    const res = await app.request('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TURN),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: 'stage2', route: 'applied', source: 'model' });
    expect(modelState.calls).toBe(1);
  });

  it('maps unclear, invalid and model-error outcomes to default', async () => {
    stubNetwork();
    const app = testApp();
    queueModel({ route: 'unclear' });
    const unclear = await app.request('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TURN),
    });
    expect(await unclear.json()).toEqual({ next: 'open-push', route: 'default', source: 'fallback' });

    queueModel({ route: 'ghost' });
    const invalid = await app.request('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TURN),
    });
    expect(await invalid.json()).toEqual({ next: 'open-push', route: 'default', source: 'fallback' });

    queueModel(new Error('boom'), new Error('boom'));
    const failed = await app.request('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TURN),
    });
    expect(await failed.json()).toEqual({ next: 'open-push', route: 'default', source: 'fallback' });
  });

  it('a visited node follows default without calling the model', async () => {
    stubNetwork();
    queueModel({ route: 'applied' });
    const app = testApp();
    const res = await app.request('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...TURN, visited: ['open'] }),
    });
    expect(await res.json()).toEqual({ next: 'open-push', route: 'default', source: 'fallback' });
    expect(modelState.calls).toBe(0);
  });

  it('rejects bad turn bodies and unknown nodes', async () => {
    stubNetwork();
    const app = testApp();
    const bad = await app.request('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packId: 'atomic-habits' }),
    });
    expect(bad.status).toBe(400);
    const ghost = await app.request('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...TURN, nodeId: 'ghost' }),
    });
    expect(ghost.status).toBe(400);
  });

  it('grades a session through the answers grader with reply nodes as questions', async () => {
    stubNetwork();
    queueModel({
      answers: [
        {
          questionId: 'open',
          points: [{ index: 0, result: 'hit', quote: 'read just one page tonight' }],
          contradictions: [],
        },
        {
          questionId: 'stage2',
          points: [
            { index: 0, result: 'hit', quote: 'lay the shoes out tonight' },
            { index: 1, result: 'none', quote: null },
          ],
          contradictions: [],
        },
      ],
    });
    const app = testApp();
    const res = await app.request('/api/grade/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packId: 'atomic-habits',
        partId: 'part-8',
        answers: [
          { nodeId: 'open', lines: [{ n: 1, text: 'I will read just one page tonight.' }] },
          { nodeId: 'stage2', lines: [{ n: 1, text: 'I will lay the shoes out tonight.' }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answers: { nodeId: string; points: { index: number; result: string; quote: string | null }[] }[];
      dropped: number;
    };
    // Evidence rules kept the real quotes; the invented point downgraded.
    expect(body.answers[0]).toMatchObject({
      nodeId: 'open',
      points: [{ index: 0, result: 'hit', quote: 'read just one page tonight' }],
    });
    expect(body.answers[1].points).toEqual([
      { index: 0, result: 'hit', quote: 'lay the shoes out tonight' },
      { index: 1, result: 'none', quote: null },
    ]);
    expect(body.dropped).toBe(0);
  });
});

describe('walking map display shape (§16.6)', () => {
  const TRAVEL_PACK = {
    packId: 'spanish-travel-lodging',
    packName: 'Spanish: Travel & Lodging',
    packVersion: '1.0.7',
    language: 'es',
    lessons: [{
      id: 'l5-travel', title: 'Lesson 5', order: 0,
      parts: [{
        id: 'p14-asking-directions', title: 'Part 14: Asking Directions',
        blurb: 'Find your way.', itemIds: ['pair-derecha'],
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

  const TRAVEL_CATALOG = {
    catalogVersion: 1,
    packs: [{
      id: 'spanish-travel-lodging', name: 'Spanish: Travel & Lodging', version: '1.0.7',
      contentHash: 'sha256:y', language: 'es', url: '/packs/spanish-travel-lodging.json',
      lessonCount: 1, cardCount: 1, status: 'ga',
    }],
  };

  function travelSession(noteHash: string) {
    return {
      schemaVersion: 1,
      role: 'travel',
      packId: 'spanish-travel-lodging',
      packVersion: '1.0.7',
      lessonId: 'l5-travel',
      partId: 'p14-asking-directions',
      builtAt: '2026-11-01',
      notes: [{ id: 'pair-derecha', hash: noteHash }],
      brief: 'Ask the way to the station.',
      cast: [{ id: 'lucia', name: 'Doña Lucía', description: 'd', voiceId: 'v', portrait: 'art/travel/lucia.webp' }],
      scene: 'art/travel/scene.webp',
      start: 'lucia-1',
      map: { start: 'Plaza', goal: 'Estación' },
      nodes: [
        {
          id: 'lucia-1', speaker: 'lucia', text: 'Dobla a la derecha.',
          gloss: 'Turn right.', scene: null, ttsText: null, audio: null, reply: true,
          noteIds: ['pair-derecha'],
          expectedPoints: [{ text: 'Say you will turn right', noteIds: ['pair-derecha'] }],
          routes: [{
            id: 'lucia-right', when: 'traveler says they will turn right',
            next: 'arrive', moves: [{ turn: 'right', blocks: 1 }],
          }],
          default: 'arrive', end: false, status: 'checked', check: null, review: null,
        },
        {
          id: 'arrive', speaker: 'lucia', text: '¡Aquí está!',
          gloss: 'Here it is!', scene: null, ttsText: null, audio: null, reply: false,
          noteIds: [], expectedPoints: [], routes: [], default: null,
          end: true, status: 'checked', check: null, review: null,
        },
      ],
    };
  }

  async function travelApp() {
    const { buildNotes } = await import('../src/shared/notes');
    const notes = buildNotes(TRAVEL_PACK as never, 'p14-asking-directions');
    const hash = notes.find((n) => n.id === 'pair-derecha')!.hash;
    setSessionFiles({ 'spanish-travel-lodging/p14-asking-directions': travelSession(hash) });
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/packs/catalog.json')) return { ok: true, json: async () => TRAVEL_CATALOG };
      if (u.endsWith('.json')) return { ok: true, json: async () => TRAVEL_PACK };
      throw new Error(`unstubbed fetch: ${u}`);
    });
    return createApp({ MODEL_API_KEY: 'test-key' }, { modelFetch: modelFetch as typeof fetch });
  }

  it('serves route moves and the session map', async () => {
    const app = await travelApp();
    const res = await app.request(
      '/api/session/spanish-travel-lodging/p14-asking-directions?role=travel',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      map: { start: string; goal: string } | null;
      nodes: { id: string; routes: { id: string; moves: { turn: string; blocks: number }[] }[] }[];
    };
    expect(body.map).toEqual({ start: 'Plaza', goal: 'Estación' });
    expect(body.nodes[0].routes).toEqual([
      { id: 'lucia-right', moves: [{ turn: 'right', blocks: 1 }] },
    ]);
    expect(JSON.stringify(body)).not.toContain('voiceId');
  });

  it('old sessions without moves or map expose [] and null', async () => {
    stubNetwork();
    const app = testApp();
    const res = await app.request('/api/session/atomic-habits/part-8?role=coach');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      map: { start: string; goal: string } | null;
      nodes: { routes: { id: string; moves: unknown[] }[] }[];
    };
    expect(body.map).toBeNull();
    for (const n of body.nodes) {
      for (const r of n.routes) expect(r.moves).toEqual([]);
    }
  });
});
