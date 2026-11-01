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
  sessions?: { coach: boolean; travel: boolean };
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
  /** Pre-recorded student voice (§4.6, §9.7); null plays the caption only. */
  audioUrl: string | null;
};

export type LineIn = { n: number; text: string };

export type SessionRole = 'coach' | 'travel';

export type SessionRouteDisplay = {
  id: string;
  /** The walking-map moves for this route (§16.6); absent on old sessions. */
  moves?: { turn: 'left' | 'right' | 'none'; blocks: number }[] | null;
};

export type SessionNodeDisplay = {
  id: string;
  speaker: string;
  text: string;
  gloss: string | null;
  scene: string;
  reply: boolean;
  end: boolean;
  noteIds: string[];
  expectedPoints: { text: string; noteIds: string[] }[];
  routes: SessionRouteDisplay[];
  audioUrl: string | null;
};

export type SessionDisplay = {
  role: SessionRole;
  brief: string;
  cast: { id: string; name: string; description: string; portrait: string }[];
  scene: string;
  start: string;
  nodes: SessionNodeDisplay[];
  /** The walking map (§16.6, travel only); null on old sessions and coach. */
  map?: { start: string; goal: string } | null;
};

export type SessionGrade = {
  answers: {
    nodeId: string;
    points: { index: number; result: 'hit' | 'partial' | 'none'; quote: string | null }[];
    contradictions: { quote: string; noteId: string; why: string }[];
    empty: boolean;
  }[];
  dropped: number;
};

export type TranscribedLine = {
  n: number;
  text: string;
  source: 'typed' | 'voice';
  startMs?: number;
  endMs?: number;
};

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
  transcribe: (wav: Uint8Array, meta: { packId: string; partId: string }) => {
    const form = new FormData();
    form.append('audio', new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'audio.wav');
    form.append('meta', JSON.stringify(meta));
    return fetch('/api/transcribe', { method: 'POST', body: form }).then(
      json<{ lines: TranscribedLine[]; audioDurationMs: number }>,
    );
  },
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
  session: (packId: string, partId: string, role: SessionRole) =>
    fetch(
      `/api/session/${encodeURIComponent(packId)}/${encodeURIComponent(partId)}?role=${encodeURIComponent(role)}`,
    ).then(json<SessionDisplay>),
  turn: (body: { packId: string; partId: string; nodeId: string; lines: LineIn[]; visited: string[] }) =>
    fetch('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<{ next: string; route: string; source: 'model' | 'fallback' }>),
  gradeSession: (body: { packId: string; partId: string; answers: { nodeId: string; lines: LineIn[] }[] }) =>
    fetch('/api/grade/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<SessionGrade>),
};
