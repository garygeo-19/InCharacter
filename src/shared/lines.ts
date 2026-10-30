// Typed prose → transcript lines (REQUIREMENTS.md §8.5, §10.1).
// The learner writes in one multi-line box; code splits the submitted text
// into numbered lines so the evidence rules (quotes checked against the
// transcript) keep working on those lines. The split is never shown: lines
// carry no sentence marks, only their order. Voice turns still become lines
// via turnsToLines in ./voice.

import type { Line } from './types';

/** Split one paragraph into sentences on . ! ? …. The end mark stays. */
function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Split submitted text into numbered lines: first by newline (dictation
 *  breaks, pasted paragraphs), then by sentence. Empty text gives no lines. */
export function splitTextToLines(text: string, source: Line['source'] = 'typed'): Line[] {
  const lines: Line[] = [];
  for (const paragraph of text.split('\n')) {
    for (const sentence of splitSentences(paragraph)) {
      lines.push({ n: lines.length + 1, text: sentence, source });
    }
  }
  return lines;
}
