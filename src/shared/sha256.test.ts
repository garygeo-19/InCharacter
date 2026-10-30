import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNotes } from './notes';
import { loadDemoPack } from './demo-fixture';
import { sha256Hex } from './sha256';

describe('sha256', () => {
  it('matches the standard test vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches node:crypto, including every seed-bank note hash', () => {
    for (const input of ['', 'fact\nLa propina\nLa propina — The tip', 'El menú vs la carta']) {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input).digest('hex'));
    }
    const bank = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../content/banks/spanish-food-shopping/p10-at-the-restaurant.json'),
        'utf8',
      ),
    ) as { notes: { id: string; hash: string }[] };
    const notes = buildNotes(loadDemoPack(), 'p10-at-the-restaurant');
    for (const n of notes) {
      expect(bank.notes.find((b) => b.id === n.id)?.hash, n.id).toBe(n.hash);
    }
  });
});
