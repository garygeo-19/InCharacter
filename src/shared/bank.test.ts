import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyCheckerResults,
  checkAnswerKey,
  checkBank,
  checkQuestionText,
  isReady,
  notesBlob,
  parseUsableStatuses,
  questionCodeErrors,
  selectBank,
  staleUsableIds,
  targetCount,
  usableQuestions,
  type Bank,
  type CheckerResult,
  type QuestionStatus,
} from './bank';
import { buildNotes } from './notes';
import { loadDemoPack } from './demo-fixture';

function loadSeedBank(): Bank {
  return JSON.parse(
    readFileSync(
      resolve(__dirname, '../../content/banks/spanish-food-shopping/p10-at-the-restaurant.json'),
      'utf8',
    ),
  ) as Bank;
}

describe('seed bank (§7.7)', () => {
  const bank = loadSeedBank();
  const notes = buildNotes(loadDemoPack(), 'p10-at-the-restaurant');

  it('covers all ten notes with 3/4/5 questions per difficulty', () => {
    expect(bank.questions).toHaveLength(12);
    expect(bank.questions.filter((q) => q.difficulty === 1)).toHaveLength(3);
    expect(bank.questions.filter((q) => q.difficulty === 2)).toHaveLength(4);
    expect(bank.questions.filter((q) => q.difficulty === 3)).toHaveLength(5);
    expect(bank.questions.filter((q) => q.type === 'misconception')).toHaveLength(3);
  });

  it('passes every §7.5 code check', () => {
    expect(checkBank(bank, notes)).toEqual([]);
  });

  it('is ready and survives the stale guard unchanged', () => {
    const usable = usableQuestions(bank, parseUsableStatuses('approved,checked'));
    expect(usable).toHaveLength(12);
    const fresh = staleUsableIds(bank, notes);
    expect(fresh.size).toBe(12);
    expect(isReady(usable.filter((q) => fresh.has(q.id)))).toBe(true);
  });

  it('drops stale questions until the part is not ready', () => {
    const changed = notes.map((n) =>
      n.id === 'fact-buen-provecho' ? { ...n, hash: '0'.repeat(64) } : n,
    );
    const fresh = staleUsableIds(bank, changed);
    // buen provecho backs q-buen-provecho-meaning, q-walking-past-diners,
    // q-buen-provecho-strangers: difficulty 1 falls to two, difficulty 2 to three.
    expect(fresh.has('q-buen-provecho-meaning')).toBe(false);
    const usable = usableQuestions(bank, parseUsableStatuses('approved,checked')).filter((q) =>
      fresh.has(q.id),
    );
    expect(usable.filter((q) => q.difficulty === 1)).toHaveLength(2);
    expect(isReady(usable)).toBe(true);
  });

  it('lists Madrid as a scene-setting noun, not an error', () => {
    const blob = notesBlob(notes);
    const q = bank.questions.find((x) => x.id === 'q-menu-in-madrid')!;
    const { errors, sceneNouns } = checkQuestionText(q.text, blob, q.id);
    expect(errors).toEqual([]);
    expect(sceneNouns).toContain('Madrid');
  });

  it('catches invented amounts and places in the answer key', () => {
    const blob = notesBlob(notes);
    expect(
      checkAnswerKey('Tip about 15 percent in Mexico.', blob, 'q'),
    ).not.toEqual([]);
    expect(checkAnswerKey('La propina is the tip.', blob, 'q')).toEqual([]);
  });

  it('rejects the four §7.1 ✗ questions slipped into a draft', () => {
    const bad = badDraftQuestions();
    const errors = checkBank({ ...bank, questions: [...bank.questions, ...bad] }, notes);
    for (const id of ['q-tip-mexico', 'q-waiter-spain', 'q-paella-oil', 'q-menu-drink']) {
      expect(errors.some((e) => e.startsWith(id)), id).toBe(true);
    }
  });

  it('parses USABLE_STATUSES', () => {
    expect(parseUsableStatuses(undefined)).toEqual(['approved', 'checked']);
    expect(parseUsableStatuses('approved')).toEqual(['approved']);
  });
});

// The four §7.1 ✗ questions as draft-bank rows, built from §7.1's questions
// with plausible overreaching answer keys.
function badDraftQuestions(): Bank['questions'] {
  return [
    {
      id: 'q-tip-mexico', status: 'draft', type: 'apply', difficulty: 2, studentId: 'leo',
      text: 'How much should we tip in Mexico?', ttsText: null,
      noteIds: ['pair-la-propina'],
      expectedPoints: [{ point: 'About 15 percent of the bill.', noteIds: ['pair-la-propina'] }],
      misconception: null, check: null, review: null, audio: null,
    },
    {
      id: 'q-waiter-spain', status: 'draft', type: 'clarify', difficulty: 1, studentId: 'maya',
      text: 'What do they call the waiter in Spain?', ttsText: null,
      noteIds: ['pair-el-camarero'],
      expectedPoints: [{ point: 'They call him \'el camarero\' in Spain.', noteIds: ['pair-el-camarero'] }],
      misconception: null, check: null, review: null, audio: null,
    },
    {
      id: 'q-paella-oil', status: 'draft', type: 'clarify', difficulty: 1, studentId: 'maya',
      text: 'Is paella made with olive oil?', ttsText: null,
      noteIds: ['ih-paella-valenciana'],
      expectedPoints: [{ point: 'Yes, it is made with olive oil from Andalusia.', noteIds: ['ih-paella-valenciana'] }],
      misconception: null, check: null, review: null, audio: null,
    },
    {
      id: 'q-menu-drink', status: 'draft', type: 'apply', difficulty: 2, studentId: 'leo',
      text: 'What comes with the menú del día? A drink?', ttsText: null,
      noteIds: ['fact-carta-not-menu'],
      expectedPoints: [{ point: 'It comes with 3 courses and a drink.', noteIds: ['fact-carta-not-menu'] }],
      misconception: null, check: null, review: null, audio: null,
    },
  ];
}

function keepResult(questionId: string): CheckerResult {
  const pass = (reason: string) => ({ pass: true, reason });
  return {
    questionId,
    answerableFromNotes: pass('The answer is in the notes.'),
    keyCorrect: pass('The key follows the notes.'),
    notTrivial: pass('Answering takes applying or comparing.'),
    clear: pass('One clear question.'),
    safe: pass('Respectful.'),
    verdict: 'keep',
  };
}

// Recorded B.5-shaped checker verdicts for the four ✗ questions: no model
// call, so this test never spends credits.
function dropResults(): CheckerResult[] {
  const drop = (
    questionId: string,
    answerReason: string,
    keyReason: string,
  ): CheckerResult => ({
    questionId,
    answerableFromNotes: { pass: false, reason: answerReason },
    keyCorrect: { pass: false, reason: keyReason },
    notTrivial: { pass: true, reason: 'Not trivially repeated.' },
    clear: { pass: true, reason: 'One clear question.' },
    safe: { pass: true, reason: 'Respectful.' },
    verdict: 'drop',
  });
  return [
    drop(
      'q-tip-mexico',
      'The notes give the word la propina, not an amount.',
      'The 15 percent figure is not in the notes.',
    ),
    drop(
      'q-waiter-spain',
      'The notes only give el mesero, not the Spain variant.',
      'El camarero is not in the notes.',
    ),
    drop(
      'q-paella-oil',
      'The notes say nothing about olive oil; only the objective mentions it.',
      'Olive oil and Andalusia are not in the notes.',
    ),
    drop(
      'q-menu-drink',
      'The notes do not say what the menú del día includes.',
      'Three courses and a drink are not in the notes.',
    ),
  ];
}

describe('M2 checker test (§12 M2, mocked checker responses)', () => {
  const bank = loadSeedBank();
  const notes = buildNotes(loadDemoPack(), 'p10-at-the-restaurant');
  const badIds = ['q-tip-mexico', 'q-waiter-spain', 'q-paella-oil', 'q-menu-drink'];

  it('the code checks reject all four ✗ and none of the 12 seed questions', () => {
    const bad = badDraftQuestions();
    const errors = checkBank({ ...bank, questions: [...bank.questions, ...bad] }, notes);
    for (const q of bad) {
      expect(questionCodeErrors(q.id, errors).length, q.id).toBeGreaterThan(0);
    }
    for (const q of bank.questions) {
      expect(questionCodeErrors(q.id, errors), q.id).toEqual([]);
    }
  });

  it('the checker rejects all four ✗ and keeps the 12 seed questions', () => {
    const draft: Bank['questions'] = [
      ...bank.questions.map((q) => ({ ...q, status: 'draft' as QuestionStatus })),
      ...badDraftQuestions(),
    ];
    const results: CheckerResult[] = [
      ...bank.questions.map((q) => keepResult(q.id)),
      ...dropResults(),
    ];
    const out = applyCheckerResults(draft, results, 'muse-wonder-1.0', '2026-10-30T00:00:00.000Z');
    const byId = new Map(out.map((q) => [q.id, q]));
    for (const id of badIds) {
      const q = byId.get(id)!;
      expect(q.status, id).toBe('rejected');
      const check = q.check as {
        model: string; at: string; results: Record<string, { pass: boolean; reason: string }>;
      };
      expect(check.model, id).toBe('muse-wonder-1.0');
      expect(
        Object.values(check.results).some((r) => !r.pass && r.reason.length > 0),
        id,
      ).toBe(true);
    }
    const kept = out.filter((q) => q.status !== 'rejected').map((q) => q.id).sort();
    expect(kept).toEqual(bank.questions.map((q) => q.id).sort());
  });

  it('selection keeps a §7.3-covering set marked checked', () => {
    expect(targetCount(notes.length)).toBe(12);
    const drafts: Bank['questions'] = bank.questions.map((q) => ({
      ...q, status: 'draft' as QuestionStatus,
    }));
    const picked = selectBank(drafts, notes);
    expect(picked).toHaveLength(12);
    expect(picked.every((q) => q.status === 'checked')).toBe(true);
    expect(checkBank({ ...bank, questions: picked }, notes)).toEqual([]);
  });
});
