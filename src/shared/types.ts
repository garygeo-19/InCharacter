// Session model from REQUIREMENTS.md §10.1. Voice only fills lines;
// everything else is text, so Type mode works first.
export type Mode = 'voice' | 'typed';

export type Line = {
  n: number;
  text: string;
  source: 'typed' | 'voice';
  startMs?: number;
  endMs?: number;
};

export type Peek = {
  noteId: string;
  phase: 'class' | 'questions' | 'session';
  startedAt: number;
  endedAt: number;
  ms: number;
};

export type Session = {
  id: string;
  packId: string;
  packVersion: string;
  lessonId: string;
  partId: string;
  mode: Mode;
  startedAt: string;
  classLines: Line[];
  picks: { questionId: string; source: 'model' | 'fallback' }[];
  answers: { questionId: string; lines: Line[] }[];
  peeks: Peek[];
};
