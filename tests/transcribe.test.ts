// POST /api/transcribe (REQUIREMENTS.md §9.6 file mode, §10.2, §10.4).
// The Meta call is mocked; the multipart shape and the turn→line mapping
// are exercised for real. Recorded fixture: tests/fixtures/transcribe-day1.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { encodeWav } from '../src/shared/voice';
import { clearCacheForTests } from '../src/shared/notes';

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

const RECORDED = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/transcribe-day1.json'), 'utf8'),
) as { audioDurationMs: number; turns: unknown[] };

type SeenRequest = { url: string; requestPart: Record<string, unknown>; audioBytes: number };

function stubNetwork(seen: SeenRequest[], metaStatus = 200) {
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.endsWith('/packs/catalog.json')) return { ok: true, json: async () => CATALOG_JSON };
    if (u.endsWith('.json')) return { ok: true, json: async () => PACK_JSON };
    if (u.includes('/asr/transcribe')) {
      const form = init?.body as FormData;
      const requestRaw = form.get('request');
      const audioRaw = form.get('audio');
      seen.push({
        url: u,
        requestPart: JSON.parse(
          typeof requestRaw === 'string' ? requestRaw : await (requestRaw as Blob).text(),
        ) as Record<string, unknown>,
        audioBytes: audioRaw instanceof Blob ? (await audioRaw.arrayBuffer()).byteLength : -1,
      });
      if (metaStatus !== 200) {
        return {
          ok: false,
          status: metaStatus,
          text: async () => 'upstream overloaded',
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, json: async () => RECORDED };
    }
    throw new Error(`unstubbed fetch: ${u}`);
  });
}

function wavForm(meta: unknown = { packId: 'spanish-food-shopping', partId: 'p10-at-the-restaurant' }) {
  const wav = encodeWav(new Int16Array(2400).fill(100));
  const form = new FormData();
  form.append('audio', new File([wav as Uint8Array<ArrayBuffer>], 'audio.wav', { type: 'audio/wav' }));
  form.append('meta', JSON.stringify(meta));
  return form;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCacheForTests();
});

describe('POST /api/transcribe (Meta mocked)', () => {
  it('forwards the WAV server-side and maps each turn to a line', async () => {
    const seen: SeenRequest[] = [];
    stubNetwork(seen);
    const app = createApp({ MODEL_API_KEY: 'test-key' });
    const res = await app.request('/api/transcribe', { method: 'POST', body: wavForm() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: { n: number; text: string; source: string; startMs?: number; endMs?: number }[];
      audioDurationMs: number;
    };
    expect(body.audioDurationMs).toBe(RECORDED.audioDurationMs);
    expect(body.lines).toHaveLength(RECORDED.turns.length);
    expect(body.lines[0]).toMatchObject({ n: 1, source: 'voice', startMs: 0 });
    expect(body.lines[0].text).toContain('Buen provecho');

    // The key never reaches the browser, and the request part follows §9.6.
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('https://api.meta.ai/v1/asr/transcribe');
    expect(seen[0].requestPart).toMatchObject({
      model: 'muse-voice-transcribe-1.0',
      mode: 'ENDPOINTING',
      audioEncoding: 'WAV',
      languageBias: ['English', 'Spanish'],
    });
    const keywords = seen[0].requestPart['keywords'] as string[];
    expect(keywords).toContain('buen provecho');
    expect(keywords.length).toBeLessThanOrEqual(50);
    expect(seen[0].audioBytes).toBeGreaterThan(44);
  });

  it('rejects missing meta, non-WAV audio, oversize audio and Meta failures', async () => {
    const seen: SeenRequest[] = [];
    stubNetwork(seen);
    const app = createApp({ MODEL_API_KEY: 'test-key' });

    const noMeta = new FormData();
    noMeta.append('audio', new File([encodeWav(new Int16Array(8)) as Uint8Array<ArrayBuffer>], 'a.wav'));
    expect((await app.request('/api/transcribe', { method: 'POST', body: noMeta })).status).toBe(400);

    const notWav = new FormData();
    notWav.append('audio', new File(['hello'], 'a.wav', { type: 'audio/wav' }));
    notWav.append('meta', JSON.stringify({ packId: 'spanish-food-shopping', partId: 'p10-at-the-restaurant' }));
    expect((await app.request('/api/transcribe', { method: 'POST', body: notWav })).status).toBe(400);
    expect(seen).toHaveLength(0);

    const big = new FormData();
    big.append('audio', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'a.wav'));
    big.append('meta', JSON.stringify({ packId: 'spanish-food-shopping', partId: 'p10-at-the-restaurant' }));
    const tooBig = await app.request('/api/transcribe', { method: 'POST', body: big });
    expect(tooBig.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('maps a Meta failure to 502 and a missing key to 502 without calling out', async () => {
    const seen: SeenRequest[] = [];
    stubNetwork(seen, 500);
    const app = createApp({ MODEL_API_KEY: 'test-key' });
    const failed = await app.request('/api/transcribe', { method: 'POST', body: wavForm() });
    expect(failed.status).toBe(502);
    // Meta's error text is included so the client can explain the failure;
    // the key itself never appears in the response.
    const failedBody = (await failed.json()) as { error: string };
    expect(failedBody.error).toContain('upstream overloaded');
    expect(failedBody.error).not.toContain('test-key');

    const noKey: SeenRequest[] = [];
    stubNetwork(noKey);
    const keyless = createApp({});
    const res = await keyless.request('/api/transcribe', { method: 'POST', body: wavForm() });
    expect(res.status).toBe(502);
    expect(noKey).toHaveLength(0);
  });

  it('rate-limits transcriptions at 60 an hour per IP (§10.4)', async () => {
    const seen: SeenRequest[] = [];
    stubNetwork(seen);
    const app = createApp({ MODEL_API_KEY: 'test-key' });
    const ip = 'transcribe-limit-probe';
    let status = 0;
    for (let i = 0; i < 61; i++) {
      const res = await app.request('/api/transcribe', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
        body: wavForm(),
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
    }
    expect(status).toBe(429);
    expect(seen.length).toBeLessThanOrEqual(60);
  });
});
