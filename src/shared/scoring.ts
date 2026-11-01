import type { Peek } from './types';
import { SCORING_CONFIG } from './scoring-config';
import type { CheckedAnswerGrade, CheckedNoteGrade, ClassVerdict } from './evidence';

// REQUIREMENTS.md §8: code computes the score from evidence-checked verdicts.

export function creditFor(verdict: ClassVerdict): number {
  return verdict === 'covered' ? 1 : verdict === 'partial' ? 0.5 : 0;
}

export type LessonScore = {
  coverage: number;
  accuracyPenalty: number;
  movesPoints: number;
  lesson: number;
  wrongCount: number;
};

/** Lesson (max 50) = coverage + moves − 2 × wrong, clamped to 0–50 (§8.1). */
export function scoreLesson(
  grades: { weight: number; verdict: ClassVerdict }[],
  distinctMoves: number,
): LessonScore {
  const totalWeight = grades.reduce((s, g) => s + g.weight, 0);
  const earned = grades.reduce((s, g) => s + g.weight * creditFor(g.verdict), 0);
  const coverage = totalWeight === 0 ? 0 : (SCORING_CONFIG.coverageMax * earned) / totalWeight;
  const wrongCount = grades.filter((g) => g.verdict === 'wrong').length;
  const accuracyPenalty = SCORING_CONFIG.wrongNotePenalty * wrongCount;
  const movesPoints = Math.min(SCORING_CONFIG.movesMax, SCORING_CONFIG.pointsPerMove * distinctMoves);
  const lesson = Math.min(50, Math.max(0, coverage + movesPoints - accuracyPenalty));
  return { coverage, accuracyPenalty, movesPoints, lesson, wrongCount };
}

export function pointCredit(result: 'hit' | 'partial' | 'none'): number {
  return result === 'hit' ? 1 : result === 'partial' ? 0.5 : 0;
}

/** Questions (max 50): Q1 15, Q2 15, Q3 20; a question's credit is the mean
 *  of its points; contradiction multiplies by 0.75 once (§8.2). */
export function scoreAnswers(
  answers: { points: { result: 'hit' | 'partial' | 'none' }[]; contradiction: boolean; empty: boolean }[],
): { questions: number; perQuestion: number[] } {
  const perQuestion = answers.map((a, i) => {
    if (a.empty || a.points.length === 0) return 0;
    const mean = a.points.reduce((s, p) => s + pointCredit(p.result), 0) / a.points.length;
    const max = SCORING_CONFIG.questionPoints[i] ?? 0;
    return mean * (a.contradiction ? SCORING_CONFIG.contradictionFactor : 1) * max;
  });
  return { questions: perQuestion.reduce((s, x) => s + x, 0), perQuestion };
}

/** Peeks cost 2 points each plus 1 per full 3 seconds open, capped at 20 (§8.4). */
export function peekPenalty(peeks: Pick<Peek, 'ms'>[]): { count: number; seconds: number; penalty: number } {
  const ms = peeks.reduce((s, p) => s + p.ms, 0);
  const seconds = ms / 1000;
  const penalty = Math.min(
    SCORING_CONFIG.peekMaxPenalty,
    SCORING_CONFIG.peekPerCount * peeks.length + Math.floor(seconds / SCORING_CONFIG.peekSecondsPerPoint),
  );
  return { count: peeks.length, seconds, penalty };
}

export type Score = {
  lesson: number;
  questions: number;
  peekPenalty: number;
  total: number;
  stars: number;
};

/** Stars: ★★★ at 85, ★★ at 65, ★ at 40; below 40 "Keep practicing" (§8.6). */
export function starsFor(roundedTotal: number): number {
  return roundedTotal >= 85 ? 3 : roundedTotal >= 65 ? 2 : roundedTotal >= 40 ? 1 : 0;
}

export function totalScore(lesson: number, questions: number, penalty: number): Score {
  const total = Math.round(lesson + questions - penalty);
  return { lesson, questions, peekPenalty: penalty, total, stars: starsFor(total) };
}

/** Celebration headline for a result, from the stars (§8.6). Warm for a
 *  strong class, encouraging for a weak one, never mocking. */
export function headlineFor(stars: number, role: 'teach' | 'coach' | 'travel' = 'teach'): string {
  if (role === 'coach') {
    if (stars >= 3) return 'Great session — Alex is on track!';
    if (stars === 2) return 'Good session — Alex has a plan.';
    if (stars === 1) return "Good effort — here's what to try next session.";
    return "Good start. Here's what to try next session.";
  }
  if (role === 'travel') {
    if (stars >= 3) return '¡Llegaste! You found your way.';
    if (stars === 2) return 'You made it — nice Spanish!';
    if (stars === 1) return "Good effort — here's what to practice next time.";
    return "Good start. Here's what to practice next time.";
  }
  if (stars >= 3) return 'Congratulations, class dismissed!';
  if (stars === 2) return 'Great class — congratulations!';
  if (stars === 1) return "Good effort — here's what to teach next time.";
  return "Good start. Here's what to teach next time.";
}

/** Show a score with at most 2 decimals, trimming zeros (29.33, 46.25, 6). */
export function formatPoints(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Every number the debrief breakdown shows, read straight from the score
 *  object so the breakdown always matches the total. The UI must not
 *  recompute any of these. */
export type ScoreBreakdown = {
  noteCount: number;
  covered: number;
  partial: number;
  missed: number;
  wrong: number;
  earnedWeight: number;
  totalWeight: number;
  coverage: number;
  moves: string[];
  movesPoints: number;
  accuracyPenalty: number;
  lesson: number;
  perQuestion: { score: number; max: number }[];
  questions: number;
  peekCount: number;
  peekSeconds: number;
  peekPenalty: number;
  total: number;
  stars: number;
};

/** Full debrief score from checked grades. */
export function scoreSession(input: {
  classGrades: CheckedNoteGrade[];
  notes: { id: string; weight: number }[];
  moves: { move: string }[];
  answers: CheckedAnswerGrade[];
  peeks: Pick<Peek, 'ms'>[];
}): Score & { lessonDetail: LessonScore; perQuestion: number[]; breakdown: ScoreBreakdown } {
  const weights = new Map(input.notes.map((n) => [n.id, n.weight]));
  const graded = input.classGrades.map((g) => ({
    weight: weights.get(g.noteId) ?? 0,
    verdict: g.verdict,
  }));
  const lessonDetail = scoreLesson(graded, input.moves.length);
  const { questions, perQuestion } = scoreAnswers(
    input.answers.map((a) => ({
      points: a.points,
      contradiction: a.contradictions.length > 0,
      empty: a.empty,
    })),
  );
  const peeks = peekPenalty(input.peeks);
  const score = totalScore(lessonDetail.lesson, questions, peeks.penalty);
  const counts = { covered: 0, partial: 0, missed: 0, wrong: 0 };
  for (const g of input.classGrades) counts[g.verdict]++;
  const breakdown: ScoreBreakdown = {
    noteCount: input.classGrades.length,
    ...counts,
    earnedWeight: graded.reduce((s, g) => s + g.weight * creditFor(g.verdict), 0),
    totalWeight: graded.reduce((s, g) => s + g.weight, 0),
    coverage: lessonDetail.coverage,
    moves: input.moves.map((m) => m.move),
    movesPoints: lessonDetail.movesPoints,
    accuracyPenalty: lessonDetail.accuracyPenalty,
    lesson: lessonDetail.lesson,
    perQuestion: perQuestion.map((s, i) => ({ score: s, max: SCORING_CONFIG.questionPoints[i] ?? 0 })),
    questions,
    peekCount: peeks.count,
    peekSeconds: peeks.seconds,
    peekPenalty: peeks.penalty,
    total: score.total,
    stars: score.stars,
  };
  return { ...score, lessonDetail, perQuestion, breakdown };
}
