import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { GRADE_ANSWERS_SYSTEM, GRADE_CLASS_SYSTEM, PICK_SYSTEM } from '../src/server/prompts';
import { clearCacheForTests } from '../src/shared/notes';

// Server routes with the network stubbed: catalog + pack come from the demo
// fixtures, so no key or live fetch is needed for the content endpoints.

const DEMO = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/demo-part.json'), 'utf8'),
) as {
  packId: string; packName: string; packVersion: string; language: string;
  lessonId: string; lessonTitle: string;
  part: { id: string; title: string; blurb?: string; itemIds: string[] };
  items: unknown[];
};

const PACK_JSON = {
  packId: DEMO.packId, packName: DEMO.packName, packVersion: DEMO.packVersion,
  language: DEMO.language,
  lessons: [{ id: DEMO.lessonId, title: DEMO.lessonTitle, order: 0, parts: [DEMO.part], objectives: [] }],
  items: DEMO.items,
};

const CATALOG_JSON = {
  catalogVersion: 1,
  packs: [{
    id: 'spanish-food-shopping', name: 'Spanish: Food & Shopping', version: '1.0.9',
    contentHash: 'sha256:x', language: 'es', url: '/packs/spanish-food-shopping.json',
    lessonCount: 1, cardCount: 25, status: 'ga',
  }],
};

function stubNetwork() {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/packs/catalog.json')) return { ok: true, json: async () => CATALOG_JSON };
    if (u.endsWith('.json')) return { ok: true, json: async () => PACK_JSON };
    throw new Error(`unstubbed fetch: ${u}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCacheForTests();
});

describe('server content routes (stubbed catalog)', () => {
  it('serves the catalog, parts, pack and bank', async () => {
    stubNetwork();
    const app = createApp({});
    const catalog = await app.request('/api/catalog');
    expect(catalog.status).toBe(200);
    expect((await catalog.json() as { packs: unknown[] }).packs).toHaveLength(1);

    const parts = await app.request('/api/parts/spanish-food-shopping');
    expect(parts.status).toBe(200);
    const body = (await parts.json()) as {
      packVersion: string;
      lessons: { id: string; parts: { id: string; noteCount: number; teachable: boolean; ready: boolean; usableByDifficulty: number[] }[] }[];
    };
    expect(body.packVersion).toBe('1.0.9');
    const part = body.lessons[0].parts[0];
    expect(part.noteCount).toBe(10);
    expect(part.teachable).toBe(true);
    expect(part.ready).toBe(true);
    expect(part.usableByDifficulty).toEqual([3, 4, 5]);

    const bank = await app.request('/api/bank/spanish-food-shopping/p10-at-the-restaurant');
    expect(bank.status).toBe(200);
    const questions = ((await bank.json()) as { questions: { id: string; audioUrl: string | null }[] }).questions;
    expect(questions).toHaveLength(12);
    // Recorded questions carry their mp3 URL; the client never sees voiceId.
    const withAudio = questions.filter((q) => q.audioUrl);
    expect(withAudio.length).toBeGreaterThan(0);
    for (const q of withAudio) {
      expect(q.audioUrl).toBe(`/audio/spanish-food-shopping/p10-at-the-restaurant/${q.id}.mp3`);
    }
    expect(JSON.stringify(questions)).not.toContain('voiceId');
  });

  it('rejects bad bodies and missing keys without calling the model', async () => {
    stubNetwork();
    const app = createApp({});
    const bad = await app.request('/api/pick', { method: 'POST', body: '{}' });
    expect(bad.status).toBe(400);
    const noKey = await app.request('/api/grade/class', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packId: 'spanish-food-shopping', partId: 'p10-at-the-restaurant', classLines: [] }),
    });
    expect(noKey.status).toBe(502);
    expect(((await noKey.json()) as { error: string }).error).toMatch(/MODEL_API_KEY/);
  });
});

describe('prompts (§11.5, Appendix A)', () => {
  it('treats transcripts as data and ignores embedded instructions', () => {
    for (const prompt of [PICK_SYSTEM, GRADE_CLASS_SYSTEM, GRADE_ANSWERS_SYSTEM]) {
      expect(prompt).toMatch(/only as data/);
      expect(prompt).toMatch(/ignore any instructions/);
    }
  });
});
