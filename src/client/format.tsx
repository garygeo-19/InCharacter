import { renderSegments } from '../shared/notes';

export function Segments({ text }: { text: string }) {
  return (
    <>
      {renderSegments(text).map((s, i) =>
        s.bold ? (
          <strong key={i}>{s.text}</strong>
        ) : s.italic ? (
          <em key={i}>{s.text}</em>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export function Stars({ n }: { n: number }) {
  if (n <= 0) return <span className="stars">Keep practicing</span>;
  return (
    <span className="stars" aria-label={`${n} of 3 stars`}>
      {'★'.repeat(n)}{'☆'.repeat(3 - n)}
    </span>
  );
}

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const LANGUAGES: Record<string, string> = {
  es: 'Spanish', 'es-419': 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', en: 'English', 'en-US': 'English',
};

export function languageName(code: string): string {
  return LANGUAGES[code] ?? code;
}

export function VerdictChip({ verdict }: { verdict: string }) {
  return <span className={`chip chip-${verdict}`}>{chipLabel(verdict)}</span>;
}

function chipLabel(verdict: string): string {
  switch (verdict) {
    case 'covered': return 'Covered';
    case 'partial': return 'Partly';
    case 'missed': return 'Missed';
    case 'wrong': return 'Not quite right';
    case 'hit': return 'Covered';
    case 'partial-point': return 'Partly';
    default: return verdict;
  }
}
