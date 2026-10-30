import { normalize, type Note } from './notes';

// REQUIREMENTS.md §8.5: code checks every quote against the transcript
// before scoring. The model can only point at what was said.

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - levenshtein(a, b) / longer;
}

/** A quote is valid when it has ≥2 words and matches text in ONE line:
 *  an exact substring of the normalized line, or a window of the line with
 *  up to 2 words more or fewer whose similarity to the quote is ≥ 0.9. */
export function quoteMatchesLine(quote: string, normalizedLine: string): boolean {
  const q = normalize(quote);
  const qWords = q.split(' ').filter(Boolean);
  if (qWords.length < 2) return false;
  if (normalizedLine.includes(q)) return true;
  const lineWords = normalizedLine.split(' ').filter(Boolean);
  for (let size = Math.max(1, qWords.length - 2); size <= qWords.length + 2; size++) {
    for (let i = 0; i + size <= lineWords.length; i++) {
      const window = lineWords.slice(i, i + size).join(' ');
      if (similarity(q, window) >= 0.9) return true;
    }
  }
  return false;
}

export function findValidQuote(quotes: string[], lines: string[]): string | null {
  const normalized = lines.map(normalize);
  for (const q of quotes) {
    if (normalized.some((line) => quoteMatchesLine(q, line))) return q;
  }
  return null;
}

function wordsOf(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

/** The quote has to be about the note: it shares an evidence word with it.
 *  A word of 6+ letters may differ by one character (recognition errors). */
export function quoteAboutNote(quote: string, evidenceWords: string[]): boolean {
  const qs = wordsOf(quote);
  return evidenceWords.some((w) =>
    qs.some((q) => (w.length >= 6 ? levenshtein(w, q) <= 1 : w === q)),
  );
}

// --- Class grades (§9.3 output + §8.5) ------------------------------------------

export type ClassVerdict = 'covered' | 'partial' | 'missed' | 'wrong';

export type ModelNoteGrade = {
  noteId: string;
  verdict: ClassVerdict;
  quotes: string[];
  why: string;
};

export type ModelMove = { move: string; quote: string };

export type CheckedNoteGrade = {
  noteId: string;
  verdict: ClassVerdict;
  quote: string | null;
  why: string;
};

export type CheckedClassGrade = {
  notes: CheckedNoteGrade[];
  moves: { move: string; quote: string }[];
  dropped: number;
};

/** Apply the evidence rules to a class grade. Missing notes count as missed;
 *  for duplicates the first wins (Appendix B.2). */
export function applyClassEvidence(
  model: { notes: ModelNoteGrade[]; moves: ModelMove[] },
  notes: Note[],
  classLines: string[],
): CheckedClassGrade {
  let dropped = 0;
  const seen = new Set<string>();
  const checked: CheckedNoteGrade[] = [];
  const byId = new Map(notes.map((n) => [n.id, n]));
  for (const g of model.notes) {
    if (seen.has(g.noteId) || !byId.has(g.noteId)) continue;
    seen.add(g.noteId);
    const note = byId.get(g.noteId)!;
    if (g.verdict === 'missed') {
      checked.push({ noteId: g.noteId, verdict: 'missed', quote: null, why: g.why });
      continue;
    }
    const quote = findValidQuote(g.quotes, classLines);
    if (quote && quoteAboutNote(quote, note.evidenceWords)) {
      checked.push({ noteId: g.noteId, verdict: g.verdict, quote, why: g.why });
    } else {
      // Covered/partial without valid evidence → missed; wrong without
      // evidence → missed (nothing is penalized without evidence).
      dropped++;
      checked.push({ noteId: g.noteId, verdict: 'missed', quote: null, why: g.why });
    }
  }
  for (const n of notes) {
    if (!seen.has(n.id)) {
      checked.push({ noteId: n.id, verdict: 'missed', quote: null, why: 'No verdict returned.' });
    }
  }
  const order = new Map(notes.map((n, i) => [n.id, i]));
  checked.sort((a, b) => (order.get(a.noteId) ?? 0) - (order.get(b.noteId) ?? 0));

  const moves: { move: string; quote: string }[] = [];
  const seenMoves = new Set<string>();
  for (const m of model.moves) {
    if (seenMoves.has(m.move)) continue;
    seenMoves.add(m.move);
    if (findValidQuote([m.quote], classLines)) moves.push({ move: m.move, quote: m.quote });
    else dropped++;
  }
  return { notes: checked, moves, dropped };
}

// --- Answer grades (§9.4 output + §8.5) ------------------------------------------

export type PointResult = 'hit' | 'partial' | 'none';

export type ModelAnswerPoint = { index: number; result: PointResult; quote: string | null };

export type ModelContradiction = { quote: string; noteId: string; why: string };

export type ModelAnswerGrade = {
  questionId: string;
  points: ModelAnswerPoint[];
  contradictions: ModelContradiction[];
};

export type CheckedAnswerGrade = {
  questionId: string;
  points: { index: number; result: PointResult; quote: string | null }[];
  contradictions: ModelContradiction[];
  empty: boolean;
};

export type CheckedAnswersGrade = { answers: CheckedAnswerGrade[]; dropped: number };

/** A hit/partial without a valid quote in that answer's lines becomes none;
 *  a contradiction without one is dropped. */
export function applyAnswersEvidence(
  model: { answers: ModelAnswerGrade[] },
  answerLinesByQuestion: Map<string, string[]>,
): CheckedAnswersGrade {
  let dropped = 0;
  const answers: CheckedAnswerGrade[] = model.answers.map((a) => {
    const lines = answerLinesByQuestion.get(a.questionId) ?? [];
    const empty = lines.length === 0;
    const points = a.points.map((p) => {
      if (p.result === 'none' || empty) return { index: p.index, result: 'none' as PointResult, quote: null as string | null };
      const quote = p.quote && findValidQuote([p.quote], lines) ? p.quote : null;
      if (!quote) dropped++;
      return { index: p.index, result: quote ? p.result : ('none' as PointResult), quote };
    });
    const contradictions = a.contradictions.filter((c) => {
      const ok = findValidQuote([c.quote], lines) !== null;
      if (!ok) dropped++;
      return ok;
    });
    return { questionId: a.questionId, points, contradictions, empty };
  });
  return { answers, dropped };
}
