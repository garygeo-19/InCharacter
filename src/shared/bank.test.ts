import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkAnswerKey,
  checkBank,
  checkQuestionText,
  isReady,
  notesBlob,
  parseUsableStatuses,
  staleUsableIds,
  usableQuestions,
  type Bank,
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
    const bad: Bank['questions'] = [
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
