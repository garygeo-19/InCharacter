// Typed wrappers around the server API (§10.2). The client never builds a
// prompt and never sees a key.

export type CatalogPack = {
  id: string;
  name: string;
  shortName?: string;
  icon?: string;
  version: string;
  description?: string;
  language: string;
  lessonCount: number;
  cardCount: number;
};

export type PartStatus = {
  id: string;
  title: string;
  blurb?: string;
  noteCount: number;
  teachable: boolean;
  ready: boolean;
  usableByDifficulty: [number, number, number];
};

export type PartsResponse = {
  packId: string;
  packVersion: string;
  lessons: { id: string; title: string; parts: PartStatus[] }[];
};

export type BankDisplay = {
  id: string;
  text: string;
  type: string;
  difficulty: number;
  studentId: string;
  noteIds: string[];
  expectedPoints: { point: string; noteIds: string[] }[];
  misconception: string | null;
};

export type LineIn = { n: number; text: string };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  catalog: () => fetch('/api/catalog').then(json<{ packs: CatalogPack[] }>),
  parts: (packId: string) =>
    fetch(`/api/parts/${encodeURIComponent(packId)}`).then(json<PartsResponse>),
  pack: (packId: string) =>
    fetch(`/api/pack/${encodeURIComponent(packId)}`).then(json<Record<string, unknown>>),
  bank: (packId: string, partId: string) =>
    fetch(`/api/bank/${encodeURIComponent(packId)}/${encodeURIComponent(partId)}`).then(
      json<{ questions: BankDisplay[] }>,
    ),
  pick: (body: { packId: string; partId: string; classLines: LineIn[]; excludeIds: string[] }) =>
    fetch('/api/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<{ picks: { questionId: string }[]; source: 'model' | 'fallback' }>),
  gradeClass: (body: { packId: string; partId: string; classLines: LineIn[] }) =>
    fetch('/api/grade/class', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(
      json<{
        notes: { noteId: string; verdict: 'covered' | 'partial' | 'missed' | 'wrong'; quote: string | null; why: string }[];
        moves: { move: string; quote: string }[];
        dropped: number;
      }>,
    ),
  gradeAnswers: (body: {
    packId: string;
    partId: string;
    answers: { questionId: string; lines: LineIn[] }[];
  }) =>
    fetch('/api/grade/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(
      json<{
        answers: {
          questionId: string;
          points: { index: number; result: 'hit' | 'partial' | 'none'; quote: string | null }[];
          contradictions: { quote: string; noteId: string; why: string }[];
          empty: boolean;
        }[];
        dropped: number;
      }>,
    ),
};
