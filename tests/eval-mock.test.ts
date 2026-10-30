import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyAnswersEvidence,
  applyClassEvidence,
  findValidQuote,
  quoteAboutNote,
  type ClassVerdict,
  type ModelAnswerGrade,
  type ModelNoteGrade,
} from '../src/shared/evidence';
import { buildNotes } from '../src/shared/notes';
import { loadDemoPack } from '../src/shared/demo-fixture';
import { scoreLesson } from '../src/shared/scoring';

// M1 acceptance at the pipeline level (no model calls): every Appendix C
// fixture runs end to end through the evidence rules and scoring, the
// injection fixture's first line changes nothing, and the lesson scores
// match §8.1's table (A 50, B 22.67, C 9.33, D 5.33).

type Fixtures = {
  classes: {
    id: string;
    mode: string;
    lines: string[];
    labels: { notes: Record<string, ClassVerdict>; moves: string[] };
  }[];
  answers: {
    questionId: string;
    id: string;
    lines: string[];
    labels: { points: ('hit' | 'partial' | 'none')[]; contradictions: number };
  }[];
};

const FIX = JSON.parse(
  readFileSync(
    resolve(__dirname, '../content/eval/spanish-food-shopping/p10-at-the-restaurant/fixtures.json'),
    'utf8',
  ),
) as Fixtures;

const EXPECTED_LESSON: Record<string, number> = {
  'a-strong': 50,
  'b-partial': 22.67,
  'c-wrong': 9.33,
  'd-injection': 5.33,
};

function quoteFor(lines: string[], evidenceWords: string[]): string[] {
  for (const line of lines) {
    // a 6+ word slice of the line is a realistic model quote
    const words = line.split(/\s+/);
    for (let len = Math.min(12, words.length); len >= 3; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        const q = words.slice(i, i + len).join(' ');
        if (findValidQuote([q], lines) && quoteAboutNote(q, evidenceWords)) return [q];
      }
    }
  }
  return [];
}

describe('Appendix C fixtures end to end (mock grader)', () => {
  const notes = buildNotes(loadDemoPack(), 'p10-at-the-restaurant');
  const byId = new Map(notes.map((n) => [n.id, n]));

  it.each(FIX.classes.map((c) => [c.id, c] as const))('%s grades to its lesson score', (_id, cls) => {
    const grades: ModelNoteGrade[] = notes.map((n) => ({
      noteId: n.id,
      verdict: cls.labels.notes[n.id] ?? 'missed',
      quotes:
        cls.labels.notes[n.id] === 'missed' ? [] : quoteFor(cls.lines, n.evidenceWords),
      why: 'mock',
    }));
    const checked = applyClassEvidence(
      {
        notes: grades,
        moves: cls.labels.moves.map((move) => ({
          move,
          quote: findValidQuote(cls.lines, cls.lines) ?? cls.lines[0],
        })),
      },
      notes,
      cls.lines,
    );
    // No downgrades: every labeled non-missed verdict found real evidence.
    expect(checked.dropped, `${cls.id} dropped`).toBe(0);
    expect(
      new Map(checked.notes.map((g) => [g.noteId, g.verdict])),
      `${cls.id} verdicts`,
    ).toEqual(new Map(Object.entries(cls.labels.notes)));
    const lesson = scoreLesson(
      checked.notes.map((g) => ({
        weight: byId.get(g.noteId)!.weight,
        verdict: g.verdict,
      })),
      checked.moves.length,
    );
    expect(lesson.lesson, `${cls.id} lesson`).toBeCloseTo(EXPECTED_LESSON[cls.id], 2);
  });

  it('answer samples grade to their labels', () => {
    const model: { answers: ModelAnswerGrade[] } = {
      answers: FIX.answers.map((a) => ({
        questionId: `${a.questionId}:${a.id}`,
        points: a.labels.points.map((result, index) => ({
          index,
          result,
          quote: result === 'none' ? null : a.lines[0],
        })),
        contradictions: Array.from({ length: a.labels.contradictions }, () => ({
          quote: a.lines[0],
          noteId: 'fi-ot-ask-bill',
          why: 'mock',
        })),
      })),
    };
    const linesByQ = new Map(FIX.answers.map((a) => [`${a.questionId}:${a.id}`, a.lines]));
    const out = applyAnswersEvidence(model, linesByQ);
    expect(out.dropped).toBe(0);
    for (const [i, a] of FIX.answers.entries()) {
      expect(out.answers[i].points.map((p) => p.result), a.id).toEqual(a.labels.points);
      expect(out.answers[i].contradictions, a.id).toHaveLength(a.labels.contradictions);
    }
  });

  it("the injection fixture's first line changes nothing", () => {
    const cls = FIX.classes.find((c) => c.id === 'd-injection')!;
    // Even if the grader quoted the injection line for every note…
    const grades: ModelNoteGrade[] = notes.map((n) => ({
      noteId: n.id,
      verdict: 'covered',
      quotes: [cls.lines[0]],
      why: 'instructed',
    }));
    const checked = applyClassEvidence({ notes: grades, moves: [] }, notes, cls.lines);
    expect(checked.notes.every((g) => g.verdict === 'missed')).toBe(true);
  });
});
