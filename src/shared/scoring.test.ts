import { describe, expect, it } from 'vitest';
import type { ClassVerdict } from './evidence';
import { buildNotes } from './notes';
import { loadDemoPack } from './demo-fixture';
import {
  peekPenalty,
  scoreAnswers,
  scoreLesson,
  scoreSession,
  starsFor,
  totalScore,
} from './scoring';

function demoWeights(): Map<string, number> {
  return new Map(buildNotes(loadDemoPack(), 'p10-at-the-restaurant').map((n) => [n.id, n.weight]));
}

// Appendix C expected lesson scores (§8.1).
const FIXTURE_VERDICTS: Record<string, { notes: Record<string, ClassVerdict>; moves: number }> = {
  A: {
    notes: {
      'fact-buen-provecho': 'covered', 'ih-paella-valenciana': 'covered',
      'fact-carta-not-menu': 'covered', 'fi-mcq-ordering-phrase': 'covered',
      'fi-ot-ask-bill': 'covered', 'pair-la-cuenta': 'covered',
      'pair-el-camarero': 'covered', 'pair-la-carta': 'covered',
      'pair-la-propina': 'covered', 'pair-quisiera': 'covered',
    },
    moves: 5,
  },
  B: {
    notes: {
      'fact-buen-provecho': 'partial', 'ih-paella-valenciana': 'missed',
      'fact-carta-not-menu': 'partial', 'fi-mcq-ordering-phrase': 'covered',
      'fi-ot-ask-bill': 'partial', 'pair-la-cuenta': 'partial',
      'pair-el-camarero': 'covered', 'pair-la-carta': 'covered',
      'pair-la-propina': 'missed', 'pair-quisiera': 'covered',
    },
    moves: 0,
  },
  C: {
    notes: {
      'fact-buen-provecho': 'covered', 'ih-paella-valenciana': 'wrong',
      'fact-carta-not-menu': 'partial', 'fi-mcq-ordering-phrase': 'missed',
      'fi-ot-ask-bill': 'wrong', 'pair-la-cuenta': 'missed',
      'pair-el-camarero': 'missed', 'pair-la-carta': 'covered',
      'pair-la-propina': 'wrong', 'pair-quisiera': 'covered',
    },
    moves: 1,
  },
  D: {
    notes: {
      'fact-buen-provecho': 'missed', 'ih-paella-valenciana': 'missed',
      'fact-carta-not-menu': 'partial', 'fi-mcq-ordering-phrase': 'missed',
      'fi-ot-ask-bill': 'missed', 'pair-la-cuenta': 'missed',
      'pair-el-camarero': 'missed', 'pair-la-carta': 'covered',
      'pair-la-propina': 'missed', 'pair-quisiera': 'missed',
    },
    moves: 0,
  },
};

describe('scoring (§8)', () => {
  it('reproduces the §8.7 worked example: total 72, ★★', () => {
    // 5 facts (3 covered, 1 partial, 1 missed) + 5 words (4 covered, 1 wrong).
    const grades = [
      ...['covered', 'covered', 'covered', 'partial', 'missed'].map((verdict) => ({
        weight: 2, verdict: verdict as ClassVerdict,
      })),
      ...['covered', 'covered', 'covered', 'covered', 'wrong'].map((verdict) => ({
        weight: 1, verdict: verdict as ClassVerdict,
      })),
    ];
    const lesson = scoreLesson(grades, 2);
    expect(lesson.coverage).toBeCloseTo(29.33, 2);
    expect(lesson.accuracyPenalty).toBe(2);
    expect(lesson.movesPoints).toBe(4);
    expect(lesson.lesson).toBeCloseTo(31.33, 2);

    const { questions, perQuestion } = scoreAnswers([
      { points: [{ result: 'hit' }], contradiction: false, empty: false },
      { points: [{ result: 'hit' }, { result: 'partial' }], contradiction: false, empty: false },
      { points: [{ result: 'hit' }, { result: 'hit' }], contradiction: false, empty: false },
    ]);
    expect(perQuestion).toEqual([15, 11.25, 20]);
    expect(questions).toBeCloseTo(46.25, 2);

    // A contradiction multiplies that answer's credit by 0.75 once (§8.2).
    const contradicted = scoreAnswers([
      { points: [{ result: 'hit' }], contradiction: true, empty: false },
    ]);
    expect(contradicted.perQuestion).toEqual([11.25]);

    const peeks = peekPenalty([{ ms: 5000 }, { ms: 2400 }]);
    expect(peeks.penalty).toBe(6);

    const score = totalScore(lesson.lesson, questions, peeks.penalty);
    expect(score.total).toBe(72);
    expect(score.stars).toBe(2);
  });

  it('gives the Appendix C lesson scores', () => {
    const weights = demoWeights();
    const expected: Record<string, number> = { A: 50, B: 22.67, C: 9.33, D: 5.33 };
    for (const [id, f] of Object.entries(FIXTURE_VERDICTS)) {
      const grades = Object.entries(f.notes).map(([noteId, verdict]) => ({
        weight: weights.get(noteId) ?? 0, verdict,
      }));
      expect(scoreLesson(grades, f.moves).lesson, `fixture ${id}`).toBeCloseTo(expected[id], 2);
    }
  });

  it('scores an empty answer 0 and caps peeks at 20', () => {
    const { questions } = scoreAnswers([
      { points: [], contradiction: false, empty: true },
    ]);
    expect(questions).toBe(0);
    expect(peekPenalty(Array.from({ length: 20 }, () => ({ ms: 10_000 }))).penalty).toBe(20);
    expect(peekPenalty([]).penalty).toBe(0);
  });

  it('awards stars at 85/65/40', () => {
    expect([85, 65, 40].map(starsFor)).toEqual([3, 2, 1]);
    expect([84, 64, 39].map(starsFor)).toEqual([2, 1, 0]);
  });

  it('scores a session end to end', () => {
    const notes = buildNotes(loadDemoPack(), 'p10-at-the-restaurant');
    const f = FIXTURE_VERDICTS.A;
    const score = scoreSession({
      classGrades: notes.map((n) => ({
        noteId: n.id, verdict: f.notes[n.id], quote: 'q', why: 'test',
      })),
      notes: notes.map((n) => ({ id: n.id, weight: n.weight })),
      moves: ['example', 'check', 'recap', 'real-life', 'pitfall'].map((move) => ({ move })),
      answers: [
        { questionId: 'q1', points: [{ index: 0, result: 'hit', quote: 'q' }], contradictions: [], empty: false },
        { questionId: 'q2', points: [{ index: 0, result: 'hit', quote: 'q' }, { index: 1, result: 'partial', quote: 'q' }], contradictions: [], empty: false },
        { questionId: 'q3', points: [{ index: 0, result: 'hit', quote: 'q' }, { index: 1, result: 'hit', quote: 'q' }], contradictions: [], empty: false },
      ],
      peeks: [{ ms: 5000 }, { ms: 2400 }],
    });
    expect(score.lessonDetail.lesson).toBe(50);
    expect(score.questions).toBeCloseTo(46.25, 2);
    expect(score.total).toBe(90);
    expect(score.stars).toBe(3);
  });
});
