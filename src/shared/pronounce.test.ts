import { describe, expect, it } from 'vitest';
import { applyPronunciations } from './pronounce';

const terms = { pez: 'pes', pescado: 'pesˈkaðo', 'el menú': 'el meˈnu', 'para mí': 'ˈpaɾa ˈmi', cerveza: 'seɾˈβesa' };

describe('applyPronunciations', () => {
  it('marks each term as IPA and leaves English alone', () => {
    expect(applyPronunciations('Should I order pez or pescado?', terms)).toBe(
      'Should I order /pes/ or /pesˈkaðo/?',
    );
  });

  it('matches whole words only, ignoring case, with accents', () => {
    expect(applyPronunciations('Cerveza, el menú, para mí, pezuña', terms)).toBe(
      '/seɾˈβesa/, /el meˈnu/, /ˈpaɾa ˈmi/, pezuña',
    );
  });

  it('returns the text unchanged with no terms', () => {
    expect(applyPronunciations('What does vino mean?', {})).toBe('What does vino mean?');
  });
});
