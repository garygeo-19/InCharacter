import { describe, expect, it } from 'vitest';
import { splitTextToLines } from './lines';

// The one-box split: submitted prose becomes numbered transcript lines for
// the §8.5 quote checks, without the learner ever seeing the split.
describe('splitTextToLines', () => {
  it('returns no lines for empty or blank text', () => {
    expect(splitTextToLines('')).toEqual([]);
    expect(splitTextToLines('   \n  ')).toEqual([]);
  });

  it('splits sentences and numbers them in order', () => {
    const lines = splitTextToLines('The menu is el menú. The bill is la cuenta! Say quisiera?');
    expect(lines.map((l) => l.text)).toEqual([
      'The menu is el menú.',
      'The bill is la cuenta!',
      'Say quisiera?',
    ]);
    expect(lines.map((l) => l.n)).toEqual([1, 2, 3]);
    expect(lines.every((l) => l.source === 'typed')).toBe(true);
  });

  it('splits on newlines as well as sentence marks', () => {
    const lines = splitTextToLines('First line here.\nSecond line here.\nThird');
    expect(lines.map((l) => l.text)).toEqual([
      'First line here.',
      'Second line here.',
      'Third',
    ]);
  });

  it('keeps one long dictation paragraph without punctuation as one line', () => {
    const text = 'la propina is the tip you leave for the server';
    const lines = splitTextToLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ n: 1, text, source: 'typed' });
  });

  it('drops blank lines and trims whitespace', () => {
    const lines = splitTextToLines('  Say buen provecho.  \n\n\nPara mí el pollo.\n');
    expect(lines.map((l) => l.text)).toEqual(['Say buen provecho.', 'Para mí el pollo.']);
    expect(lines.map((l) => l.n)).toEqual([1, 2]);
  });

  it('keeps quotes matchable: each evidence phrase lands in one line', () => {
    const lines = splitTextToLines('The menu is el menú and the bill is la cuenta. To order say quisiera.');
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toContain('la cuenta');
    expect(lines[1].text).toContain('quisiera');
  });
});
