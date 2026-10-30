import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  isReady,
  parseUsableStatuses,
  staleUsableIds,
  usableQuestions,
  type Bank,
  type BankQuestion,
} from '../shared/bank';
import { buildNotes, fetchPack, isTeachable, type CatalogEntry, type Note } from '../shared/notes';

// Server content: live packs from the catalog, banks from content/banks/.
// The client never sees prompts or keys; it only gets notes and verdicts.

const BankFileSchema = z.object({
  schemaVersion: z.literal(1),
  packId: z.string(),
  packVersion: z.string(),
  lessonId: z.string(),
  partId: z.string(),
  builtAt: z.string(),
  notes: z.array(z.object({ id: z.string(), hash: z.string() })),
  questions: z.array(z.any()),
});

export function loadBank(packId: string, partId: string): Bank | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), 'content', 'banks', packId, `${partId}.json`), 'utf8'),
    ) as unknown;
    const parsed = BankFileSchema.parse(raw);
    if (parsed.packId !== packId || parsed.partId !== partId) return null;
    return parsed as Bank;
  } catch {
    return null;
  }
}

export type PartStatus = {
  id: string;
  title: string;
  blurb?: string;
  noteCount: number;
  teachable: boolean;
  ready: boolean;
  usableByDifficulty: [number, number, number];
};

export async function partStatuses(
  base: string,
  entry: CatalogEntry,
  statuses: string[],
): Promise<{ packVersion: string; lessons: { id: string; title: string; parts: PartStatus[] }[] }> {
  const pack = await fetchPack(base, entry);
  const lessons = pack.lessons.map((lesson) => {
    const parts: PartStatus[] = lesson.parts.map((part) => {
      let notes: Note[] = [];
      try {
        notes = buildNotes(pack, part.id);
      } catch {
        notes = [];
      }
      const bank = loadBank(entry.id, part.id);
      let usable: BankQuestion[] = [];
      if (bank && notes.length > 0) {
        const fresh = staleUsableIds(bank, notes);
        usable = usableQuestions(bank, statuses).filter((q) => fresh.has(q.id));
      }
      return {
        id: part.id,
        title: part.title,
        blurb: part.blurb,
        noteCount: notes.length,
        teachable: isTeachable(notes),
        ready: isReady(usable),
        usableByDifficulty: [
          usable.filter((q) => q.difficulty === 1).length,
          usable.filter((q) => q.difficulty === 2).length,
          usable.filter((q) => q.difficulty === 3).length,
        ] as [number, number, number],
      };
    });
    return { id: lesson.id, title: lesson.title, parts };
  });
  return { packVersion: pack.packVersion, lessons };
}

/** Notes plus the fresh, usable bank questions for grading and picking. */
export async function classContent(
  base: string,
  entry: CatalogEntry,
  partId: string,
  statuses: string[],
): Promise<{ notes: Note[]; questions: BankQuestion[] }> {
  const pack = await fetchPack(base, entry);
  const notes = buildNotes(pack, partId);
  const bank = loadBank(entry.id, partId);
  if (!bank) throw new Error('no bank for this part');
  const fresh = staleUsableIds(bank, notes);
  return { notes, questions: usableQuestions(bank, statuses).filter((q) => fresh.has(q.id)) };
}
