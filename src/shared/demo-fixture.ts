import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import {
  buildOutline,
  isTeachable,
  PackSchema,
  type Note,
  type Pack,
} from './notes';

// Shared helper (not a test file): the §6.5 demo-class expectations used by
// the notes, bank, picker, evidence and scoring tests.

type DemoPartFixture = {
  packId: string;
  packName: string;
  packVersion: string;
  language: string;
  lessonId: string;
  lessonTitle: string;
  part: { id: string; title: string; blurb?: string; itemIds: string[] };
  items: unknown[];
};

export function loadDemoPack(): Pack {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../../tests/fixtures/demo-part.json'), 'utf8'),
  ) as DemoPartFixture;
  return PackSchema.parse({
    packId: raw.packId,
    packName: raw.packName,
    packVersion: raw.packVersion,
    language: raw.language,
    lessons: [
      { id: raw.lessonId, title: raw.lessonTitle, order: 0, parts: [raw.part], objectives: [] },
    ],
    items: raw.items,
  });
}

export const EXPECTED_ROWS: { id: string; kind: Note['kind']; label: string; text: string }[] = [
  {
    id: 'fact-buen-provecho', kind: 'fact', label: 'The Meaning of Buen Provecho',
    text: 'It is common courtesy to say **Buen provecho** (*Enjoy your meal*) when food is served or when walking past people who are eating. It fosters a communal, social atmosphere.',
  },
  {
    id: 'ih-paella-valenciana', kind: 'fact', label: 'Paella valenciana',
    text: 'Saffron rice with rabbit, chicken, and beans — a classic dish of Valencia.\nValencia\'s dish — and the traditional version has rabbit, not seafood.',
  },
  {
    id: 'fact-carta-not-menu', kind: 'fact', label: 'El menú vs la carta',
    text: '**El menú** is the list of dishes you order from, and **la carta** means the same thing. In Spain, **el menú** usually means something else: the **menú del día**, a fixed-price set meal and one of the better deals at lunch. Order from the menu with *Quisiera...*, or — casually, as the waiter works around the table — *Para mí, el pollo*.',
  },
  {
    id: 'fi-mcq-ordering-phrase', kind: 'fact', label: 'Para mí, el pollo',
    text: 'When a waiter goes around the table, \'Para mí, el pollo\' (\'For me, the chicken\') is the natural, polite way to state your order.',
  },
  {
    id: 'fi-ot-ask-bill', kind: 'fact', label: 'La cuenta, por favor',
    text: 'In Spain, servers don\'t bring the check automatically, so diners ask for it with \'la cuenta, por favor.\'',
  },
  { id: 'pair-la-cuenta', kind: 'word', label: 'La cuenta', text: 'La cuenta — The bill / check' },
  { id: 'pair-el-camarero', kind: 'word', label: 'El mesero', text: 'El mesero — The waiter' },
  { id: 'pair-la-carta', kind: 'word', label: 'El menú', text: 'El menú — The menu' },
  { id: 'pair-la-propina', kind: 'word', label: 'La propina', text: 'La propina — The tip' },
  { id: 'pair-quisiera', kind: 'word', label: 'Quisiera...', text: 'Quisiera... — I would like...' },
];

export const EXPECTED_ANCHORS: Record<string, string[]> = {
  'fact-buen-provecho': ['buen provecho', 'enjoy your meal'],
  'ih-paella-valenciana': ['paella valenciana'],
  'fact-carta-not-menu': ['el menú', 'la carta', 'menú del día', 'quisiera', 'para mí, el pollo'],
  'fi-mcq-ordering-phrase': ['para mí, el pollo', 'for me, the chicken'],
  'fi-ot-ask-bill': ['la cuenta, por favor'],
  'pair-la-cuenta': ['la cuenta'],
  'pair-el-camarero': ['el mesero'],
  'pair-la-carta': ['el menú'],
  'pair-la-propina': ['la propina'],
  'pair-quisiera': ['quisiera'],
};

export function expectDemoNotes(notes: Note[]): void {
  // Facts first in itemIds order, then words — pairs lead itemIds (§6.5).
  expect(notes.map((n) => n.id)).toEqual(EXPECTED_ROWS.map((r) => r.id));
  for (const [i, row] of EXPECTED_ROWS.entries()) {
    expect(notes[i].kind, `${row.id} kind`).toBe(row.kind);
    expect(notes[i].label, `${row.id} label`).toBe(row.label);
    expect(notes[i].text, `${row.id} text`).toBe(row.text);
    expect(notes[i].weight, `${row.id} weight`).toBe(row.kind === 'word' ? 1 : 2);
    expect(notes[i].anchors, `${row.id} anchors`).toEqual(EXPECTED_ANCHORS[row.id]);
    expect(notes[i].evidenceWords.length, `${row.id} has evidence words`).toBeGreaterThan(0);
    expect(notes[i].hash, `${row.id} hash`).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(isTeachable(notes)).toBe(true);
  const outline = buildOutline(notes);
  expect(outline.facts.map((r) => r.label)).toEqual(EXPECTED_ROWS.slice(0, 5).map((r) => r.label));
  expect(outline.words.map((r) => r.label)).toEqual([
    'La cuenta', 'El mesero', 'El menú', 'La propina', 'Quisiera...',
  ]);
}
