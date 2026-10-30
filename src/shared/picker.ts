import { normalize } from './notes';

// REQUIREMENTS.md §9.2: code validation of the model's picks, and the
// rules-based fallback. Shared so the server and (for tests) the client agree.

export type UsableQuestion = {
  id: string;
  difficulty: 1 | 2 | 3;
  noteIds: string[];
  /** Union of the evidence words (§6.3) of the question's notes. */
  evidenceWords: string[];
  /** Position in the bank file; breaks fallback ties. */
  bankIndex: number;
};

export type Picks = { questionId: string }[];

function sharesNote(a: string[], b: string[]): boolean {
  return a.some((id) => b.includes(id));
}

/** Validation (§9.2): exactly three distinct usable ids, difficulties 1–3 in
 *  order, no two sharing a note, none excluded. */
export function validatePicks(
  picks: { questionId: string }[],
  usable: UsableQuestion[],
  excludeIds: string[],
): string[] {
  const errors: string[] = [];
  const byId = new Map(usable.map((q) => [q.id, q]));
  if (picks.length !== 3) errors.push(`need exactly 3 picks, got ${picks.length}`);
  const ids = picks.map((p) => p.questionId);
  if (new Set(ids).size !== ids.length) errors.push('picks must be distinct');
  const want: (1 | 2 | 3)[] = [1, 2, 3];
  picks.forEach((p, i) => {
    const q = byId.get(p.questionId);
    if (!q) {
      errors.push(`${p.questionId} is not usable`);
      return;
    }
    if (i < 3 && q.difficulty !== want[i]) {
      errors.push(`${p.questionId} is difficulty ${q.difficulty}, pick ${i + 1} needs ${want[i]}`);
    }
    if (excludeIds.includes(p.questionId)) errors.push(`${p.questionId} was asked recently`);
  });
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = byId.get(ids[i]);
      const b = byId.get(ids[j]);
      if (a && b && sharesNote(a.noteIds, b.noteIds)) {
        errors.push(`${ids[i]} and ${ids[j]} share a note`);
      }
    }
  }
  return errors;
}

function evidenceHits(evidenceWords: string[], transcript: string): number {
  const counts = new Map<string, number>();
  for (const w of normalize(transcript).split(' ').filter(Boolean)) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return evidenceWords.reduce((sum, w) => sum + (counts.get(w) ?? 0), 0);
}

/** Fallback (§9.2): per difficulty, prefer non-excluded questions sharing no
 *  note with earlier picks (relaxing each rule in turn), probing what the
 *  teacher skipped — the candidate whose notes' evidence words appear least
 *  in the class transcript, ties broken by bank order. */
export function fallbackPick(
  usable: UsableQuestion[],
  excludeIds: string[],
  transcript: string,
): Picks {
  const picks: Picks = [];
  const pickedNotes: string[] = [];
  for (const d of [1, 2, 3] as const) {
    const atLevel = usable.filter((q) => q.difficulty === d);
    let candidates = atLevel.filter(
      (q) => !excludeIds.includes(q.id) && !sharesNote(q.noteIds, pickedNotes),
    );
    if (candidates.length === 0) {
      candidates = atLevel.filter((q) => !sharesNote(q.noteIds, pickedNotes));
    }
    if (candidates.length === 0) candidates = atLevel;
    if (candidates.length === 0) throw new Error(`no usable difficulty-${d} question`);
    candidates.sort(
      (a, b) =>
        evidenceHits(a.evidenceWords, transcript) - evidenceHits(b.evidenceWords, transcript) ||
        a.bankIndex - b.bankIndex,
    );
    const [best] = candidates;
    picks.push({ questionId: best.id });
    pickedNotes.push(...best.noteIds);
  }
  return picks;
}
