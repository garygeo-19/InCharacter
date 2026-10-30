import { describe, expect, it } from 'vitest';
import type { ClassVerdict } from './evidence';
import { buildNotes } from './notes';
import { loadDemoPack } from './demo-fixture';
import {
  formatPoints,
  headlineFor,
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

  it('reports a breakdown that adds up to the §8.7 total of 72', () => {
    // Same worked example as above, through scoreSession: 5 facts
    // (3 covered, 1 partial, 1 missed) + 5 words (4 covered, 1 wrong),
    // 2 moves, Q1 hit / Q2 hit+partial / Q3 hit+hit, 2 peeks of 7.4 s.
    const factVerdicts: ClassVerdict[] = ['covered', 'covered', 'covered', 'partial', 'missed'];
    const wordVerdicts: ClassVerdict[] = ['covered', 'covered', 'covered', 'covered', 'wrong'];
    const notes = [
      ...factVerdicts.map((_, i) => ({ id: `fact-${i}`, weight: 2 })),
      ...wordVerdicts.map((_, i) => ({ id: `word-${i}`, weight: 1 })),
    ];
    const score = scoreSession({
      classGrades: [
        ...factVerdicts.map((verdict, i) => ({ noteId: `fact-${i}`, verdict, quote: 'q', why: 'test' })),
        ...wordVerdicts.map((verdict, i) => ({ noteId: `word-${i}`, verdict, quote: 'q', why: 'test' })),
      ],
      notes,
      moves: [{ move: 'example' }, { move: 'recap' }],
      answers: [
        { questionId: 'q1', points: [{ index: 0, result: 'hit', quote: 'q' }], contradictions: [], empty: false },
        { questionId: 'q2', points: [{ index: 0, result: 'hit', quote: 'q' }, { index: 1, result: 'partial', quote: 'q' }], contradictions: [], empty: false },
        { questionId: 'q3', points: [{ index: 0, result: 'hit', quote: 'q' }, { index: 1, result: 'hit', quote: 'q' }], contradictions: [], empty: false },
      ],
      peeks: [{ ms: 5000 }, { ms: 2400 }],
    });
    const b = score.breakdown;
    expect(b.noteCount).toBe(10);
    expect([b.covered, b.partial, b.missed, b.wrong]).toEqual([7, 1, 1, 1]);
    expect(b.earnedWeight).toBe(11);
    expect(b.totalWeight).toBe(15);
    expect(b.coverage).toBeCloseTo(29.33, 2);
    expect(b.moves).toEqual(['example', 'recap']);
    expect(b.movesPoints).toBe(4);
    expect(b.accuracyPenalty).toBe(2);
    expect(b.lesson).toBeCloseTo(31.33, 2);
    expect(b.perQuestion.map((q) => q.score)).toEqual([15, 11.25, 20]);
    expect(b.perQuestion.map((q) => q.max)).toEqual([15, 15, 20]);
    expect(b.questions).toBeCloseTo(46.25, 2);
    expect(b.peekCount).toBe(2);
    expect(b.peekSeconds).toBeCloseTo(7.4, 5);
    expect(b.peekPenalty).toBe(6);
    // The breakdown adds up to the total shown: 31.33 + 46.25 − 6 = 71.58 → 72.
    expect(Math.round(b.lesson + b.questions - b.peekPenalty)).toBe(b.total);
    expect(b.total).toBe(72);
    expect(b.stars).toBe(2);
    expect(formatPoints(b.coverage)).toBe('29.33');
    expect(formatPoints(b.questions)).toBe('46.25');
  });

  it('celebrates warmly for strong classes and kindly for weak ones', () => {
    expect(headlineFor(3)).toBe('Congratulations, class dismissed!');
    expect(headlineFor(2)).toBe('Great class — congratulations!');
    expect(headlineFor(1)).toBe("Good effort — here's what to teach next time.");
    expect(headlineFor(0)).toBe("Good start. Here's what to teach next time.");
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
