import { normalize, type Note } from './notes';

// REQUIREMENTS.md §7: banks, the stale guard, and the §7.5 code checks
// (schema, length, coverage, nothing-new-in-answer-key, numbers-in-question).

export type QuestionType = 'clarify' | 'apply' | 'compare' | 'misconception';
export type Difficulty = 1 | 2 | 3;
export type StudentId = 'maya' | 'leo' | 'priya' | 'sam';
export type QuestionStatus = 'draft' | 'checked' | 'approved' | 'rejected';

export type BankQuestion = {
  id: string;
  status: QuestionStatus;
  type: QuestionType;
  difficulty: Difficulty;
  studentId: StudentId;
  text: string;
  ttsText: string | null;
  noteIds: string[];
  expectedPoints: { point: string; noteIds: string[] }[];
  misconception: string | null;
  check: unknown;
  review: unknown;
  audio: unknown;
};

export type Bank = {
  schemaVersion: 1;
  packId: string;
  packVersion: string;
  lessonId: string;
  partId: string;
  builtAt: string;
  notes: { id: string; hash: string }[];
  questions: BankQuestion[];
};

// §7.2: each type is asked by one student at one difficulty.
export const TYPE_MAP: Record<QuestionType, { studentId: StudentId; difficulty: Difficulty }> = {
  clarify: { studentId: 'maya', difficulty: 1 },
  apply: { studentId: 'leo', difficulty: 2 },
  compare: { studentId: 'priya', difficulty: 3 },
  misconception: { studentId: 'sam', difficulty: 3 },
};

const STATUSES: QuestionStatus[] = ['draft', 'checked', 'approved', 'rejected'];

/** Production uses `approved` only; development `approved,checked` (§7.5). */
export function parseUsableStatuses(raw: string | undefined): string[] {
  if (!raw) return ['approved', 'checked'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function usableQuestions(bank: Bank, statuses: string[]): BankQuestion[] {
  return bank.questions.filter((q) => statuses.includes(q.status));
}

/** Stale guard (§7.6): a question is usable only while all its notes still
 *  exist with the hashes recorded when the bank was written. */
export function staleUsableIds(bank: Bank, notes: Note[]): Set<string> {
  const hashes = new Map(notes.map((n) => [n.id, n.hash]));
  const recorded = new Map(bank.notes.map((n) => [n.id, n.hash]));
  const ok = new Set<string>();
  for (const q of bank.questions) {
    if (q.noteIds.length > 0 && q.noteIds.every((id) => hashes.get(id) === recorded.get(id))) {
      ok.add(q.id);
    }
  }
  return ok;
}

/** Ready: at least two usable questions at each difficulty (§7.6). */
export function isReady(questions: BankQuestion[]): boolean {
  return [1, 2, 3].every((d) => questions.filter((q) => q.difficulty === d).length >= 2);
}

// --- §7.5 code checks ----------------------------------------------------------

const QUOTED_RE = /(?:^|[\s([{])'([^']+)'/g;
const HAS_DIGIT = /\d/;
const HAS_UPPER = /[A-ZÀ-Þ]/;
const HAS_ACCENT = /[^\x00-\x7F]/;

function quotedPhrases(text: string): string[] {
  const out: string[] = [];
  QUOTED_RE.lastIndex = 0;
  for (let m = QUOTED_RE.exec(text); m; m = QUOTED_RE.exec(text)) out.push(m[1]);
  return out;
}

function isPronounI(word: string): boolean {
  return word === 'I' || word.startsWith("I'");
}

function sentences(text: string): string[][] {
  return text
    .split(/[.!?…]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((s) => s.length > 0);
}

export type NotesBlob = { texts: string[]; tokens: Set<string> };

export function notesBlob(notes: Note[]): NotesBlob {
  const texts = notes.map((n) => normalize(`${n.label}\n${n.text}`));
  const tokens = new Set<string>();
  for (const t of texts) for (const w of t.split(' ').filter(Boolean)) tokens.add(w);
  return { texts, tokens };
}

/** Nothing new in the answer key (§7.5): numbers, quoted phrases, capitalized
 *  non-first words and accented words in each expected point must appear in
 *  the notes after normalization. Returns error strings. */
export function checkAnswerKey(point: string, blob: NotesBlob, where: string): string[] {
  const errors: string[] = [];
  const norm = normalize(point);
  for (const tok of norm.split(' ').filter(Boolean)) {
    if (HAS_DIGIT.test(tok) && !blob.tokens.has(tok)) {
      errors.push(`${where}: number "${tok}" is not in the notes`);
    }
  }
  for (const q of quotedPhrases(point)) {
    if (!blob.texts.some((t) => t.includes(normalize(q)))) {
      errors.push(`${where}: quoted phrase "${q}" is not in the notes`);
    }
  }
  for (const words of sentences(point)) {
    words.forEach((word, i) => {
      if (i === 0 || isPronounI(word)) return;
      if (HAS_ACCENT.test(word) || HAS_UPPER.test(word)) {
        const n = normalize(word);
        if (n && !blob.tokens.has(n)) errors.push(`${where}: "${word}" is not in the notes`);
      }
    });
  }
  return errors;
}

export type TextCheck = { errors: string[]; sceneNouns: string[] };

/** Question text check (§7.5): numbers must appear in the notes; scene-setting
 *  proper nouns are allowed but listed for the reviewer. */
export function checkQuestionText(text: string, blob: NotesBlob, where: string): TextCheck {
  const errors: string[] = [];
  const sceneNouns: string[] = [];
  for (const tok of normalize(text).split(' ').filter(Boolean)) {
    if (HAS_DIGIT.test(tok) && !blob.tokens.has(tok)) {
      errors.push(`${where}: number "${tok}" is not in the notes`);
    }
  }
  for (const words of sentences(text)) {
    words.forEach((word, i) => {
      if (i === 0 || isPronounI(word) || !HAS_UPPER.test(word)) return;
      const n = normalize(word);
      if (n && !blob.tokens.has(n) && !sceneNouns.includes(word)) sceneNouns.push(word);
    });
  }
  return { errors, sceneNouns };
}

// --- §7.5 steps 4–5: the checker verdicts and the selection ---------------------

export type CheckerCheck = { pass: boolean; reason: string };

/** One B.5 result row: five pass/fail checks plus the keep/drop verdict. */
export type CheckerResult = {
  questionId: string;
  answerableFromNotes: CheckerCheck;
  keyCorrect: CheckerCheck;
  notTrivial: CheckerCheck;
  clear: CheckerCheck;
  safe: CheckerCheck;
  verdict: 'keep' | 'drop';
};

const CHECK_KEYS = [
  'answerableFromNotes',
  'keyCorrect',
  'notTrivial',
  'clear',
  'safe',
] as const;

/** Errors from checkBank that belong to one question (§7.5 step 3).
 *  Bank-level errors (counts, coverage of other notes) match no question. */
export function questionCodeErrors(questionId: string, errors: string[]): string[] {
  return errors.filter(
    (e) => e.startsWith(`${questionId}:`) || e.startsWith(`${questionId} `),
  );
}

/** Apply §7.5 step 4: any failing check — or a drop verdict, or a missing
 *  verdict — makes the question `rejected`, with the reason recorded in
 *  `check`. Passing questions keep their status and get `check` recorded. */
export function applyCheckerResults(
  questions: BankQuestion[],
  results: CheckerResult[],
  model: string,
  at: string,
): BankQuestion[] {
  const byId = new Map(results.map((r) => [r.questionId, r]));
  return questions.map((q) => {
    const r = byId.get(q.id);
    const checks: Record<string, CheckerCheck> = {};
    for (const k of CHECK_KEYS) {
      checks[k] = r
        ? r[k]
        : { pass: false, reason: 'No checker verdict for this question.' };
    }
    const failed = CHECK_KEYS.some((k) => !checks[k].pass);
    const rejected = !r || r.verdict === 'drop' || failed;
    return {
      ...q,
      status: rejected ? ('rejected' as const) : q.status,
      check: { model, at, results: checks },
    };
  });
}

/** Draft target: two more than the note count, clamped to 6–14 (§7.3). */
export function targetCount(noteCount: number): number {
  return Math.min(14, Math.max(6, noteCount + 2));
}

/** §7.5 step 5: keep the passing (`draft`) questions that meet §7.3,
 *  preferring variety (different notes, least-covered first), marked
 *  `checked`. Deterministic: ties break by bank order (sorts are stable). */
export function selectBank(candidates: BankQuestion[], notes: Note[]): BankQuestion[] {
  const remaining = candidates.filter((q) => q.status === 'draft');
  const target = targetCount(notes.length);
  const needMisconception = notes.some((n) => n.kind !== 'word');
  const picked: BankQuestion[] = [];
  const coverCount = new Map<string, number>();
  const covered = (id: string): number => coverCount.get(id) ?? 0;
  const take = (q: BankQuestion): void => {
    picked.push(q);
    remaining.splice(remaining.indexOf(q), 1);
    for (const id of q.noteIds) coverCount.set(id, covered(id) + 1);
  };
  // Least-covered notes first, so questions probe different notes.
  const variety = (q: BankQuestion): number =>
    q.noteIds.reduce((s, id) => s + covered(id), 0);
  const byVariety = (a: BankQuestion, b: BankQuestion): number => variety(a) - variety(b);

  // Phase 1: cover every note, preferring questions that cover the most
  // uncovered notes (with a nudge for a misconception question when one is
  // required and none is picked yet).
  for (;;) {
    if (!notes.some((n) => covered(n.id) === 0) || remaining.length === 0) break;
    const wantMis = needMisconception && !picked.some((q) => q.type === 'misconception');
    const scored = [...remaining].sort((a, b) => {
      const cover = (q: BankQuestion): number =>
        q.noteIds.filter((id) => covered(id) === 0).length +
        (wantMis && q.type === 'misconception' ? 0.5 : 0);
      return cover(b) - cover(a);
    });
    if (scored[0].noteIds.every((id) => covered(id) > 0)) break;
    take(scored[0]);
  }
  // Phase 2: at least two questions at each difficulty.
  for (const d of [1, 2, 3] as Difficulty[]) {
    while (picked.filter((q) => q.difficulty === d).length < 2) {
      const cands = remaining.filter((q) => q.difficulty === d).sort(byVariety);
      if (cands.length === 0) break;
      take(cands[0]);
    }
  }
  // Phase 3: fill to the target, least-covered notes first.
  while (picked.length < target && remaining.length > 0) {
    let pool = remaining;
    if (needMisconception && !picked.some((q) => q.type === 'misconception')) {
      const misc = remaining.filter((q) => q.type === 'misconception');
      if (misc.length > 0) pool = misc;
    }
    take([...pool].sort(byVariety)[0]);
  }
  return picked.map((q) => ({ ...q, status: 'checked' as const }));
}

/** Full §7.5 code checks for a bank against the part's notes. */
export function checkBank(bank: Bank, notes: Note[]): string[] {
  const errors: string[] = [];
  const noteIds = new Set(notes.map((n) => n.id));
  const hasFact = notes.some((n) => n.kind !== 'word');
  const blob = notesBlob(notes);

  if (bank.questions.length < 6 || bank.questions.length > 14) {
    errors.push(`bank has ${bank.questions.length} questions, need 6–14`);
  }
  const seen = new Set<string>();
  for (const q of bank.questions) {
    if (!/^q-[a-z0-9]+(-[a-z0-9]+)*$/.test(q.id)) {
      errors.push(`${q.id}: id must be "q-" plus a slug`);
    }
    if (seen.has(q.id)) errors.push(`${q.id}: duplicate id`);
    seen.add(q.id);
    if (!STATUSES.includes(q.status)) errors.push(`${q.id}: bad status ${q.status}`);
    const want = TYPE_MAP[q.type];
    if (!want) errors.push(`${q.id}: bad type ${q.type}`);
    else {
      if (q.studentId !== want.studentId) errors.push(`${q.id}: ${q.type} must be asked by ${want.studentId}`);
      if (q.difficulty !== want.difficulty) errors.push(`${q.id}: ${q.type} must be difficulty ${want.difficulty}`);
    }
    if (q.noteIds.length < 1 || q.noteIds.length > 3) errors.push(`${q.id}: need 1–3 noteIds`);
    for (const id of q.noteIds) if (!noteIds.has(id)) errors.push(`${q.id}: unknown note ${id}`);
    if (q.expectedPoints.length < 1 || q.expectedPoints.length > 3) {
      errors.push(`${q.id}: need 1–3 expectedPoints`);
    }
    for (const [i, p] of q.expectedPoints.entries()) {
      if (p.noteIds.length < 1 || p.noteIds.length > 3) errors.push(`${q.id}: point ${i} needs 1–3 noteIds`);
      for (const id of p.noteIds) if (!noteIds.has(id)) errors.push(`${q.id}: point ${i} cites unknown note ${id}`);
      errors.push(...checkAnswerKey(p.point, blob, `${q.id} point ${i}`));
    }
    if (q.type === 'misconception' ? q.misconception == null : q.misconception != null) {
      errors.push(`${q.id}: misconception field ${q.type === 'misconception' ? 'must state the wrong belief' : 'is only for type misconception'}`);
    }
    if (q.text.length > 160) errors.push(`${q.id}: text is ${q.text.length} chars, max 160`);
    if (!q.text.includes('?')) errors.push(`${q.id}: text has no question mark`);
    errors.push(...checkQuestionText(q.text, blob, q.id).errors);
  }
  for (const d of [1, 2, 3] as Difficulty[]) {
    if (bank.questions.filter((q) => q.difficulty === d).length < 2) {
      errors.push(`fewer than two difficulty-${d} questions`);
    }
  }
  if (hasFact && !bank.questions.some((q) => q.type === 'misconception')) {
    errors.push('part has a fact note but no misconception question');
  }
  for (const n of notes) {
    if (!bank.questions.some((q) => q.noteIds.includes(n.id))) {
      errors.push(`note ${n.id} is the subject of no question`);
    }
  }
  return errors;
}
