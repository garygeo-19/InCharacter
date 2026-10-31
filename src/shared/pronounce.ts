/**
 * Voice-only pronunciation for Spanish terms inside English questions.
 * Eleven v4 reads IPA written between forward slashes, so each known term
 * becomes /ipa/ in the text sent to the voice. Captions never use this.
 */
export type Lexicon = Record<string, string>;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyPronunciations(text: string, terms: Lexicon): string {
  const keys = Object.keys(terms).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return text;
  const byLower = new Map(keys.map((k) => [k.toLowerCase(), terms[k]]));
  const pattern = new RegExp(`(?<!\\p{L})(?:${keys.map(escapeRegExp).join('|')})(?!\\p{L})`, 'giu');
  return text.replace(pattern, (m) => `/${byLower.get(m.toLowerCase())}/`);
}
