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

// Bank files have two sources. On Node they are read from content/banks/ on
// disk; on Cloudflare Workers there is no filesystem, so the Worker entry
// registers its bundled JSON imports with setBankFiles() before serving.
// The disk read reaches the fs builtin at run time (no static node: import),
// so this module bundles cleanly for Workers. Parsed banks are cached in
// module scope, so a request never re-reads or re-parses them.
let bankFiles: Record<string, unknown> | null = null;
const bankCache = new Map<string, Bank | null>();

export function setBankFiles(map: Record<string, unknown>): void {
  bankFiles = map;
  bankCache.clear();
}

function readBankDisk(packId: string, partId: string): unknown {
  try {
    const proc = (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => unknown; cwd?: () => string };
      }
    ).process;
    const getBuiltin = proc?.getBuiltinModule;
    if (typeof getBuiltin !== 'function') return null;
    const fs = getBuiltin.call(proc, 'node:fs') as {
      readFileSync?: (path: string, encoding: string) => string;
    };
    const cwd = typeof proc?.cwd === 'function' ? proc.cwd() : '.';
    if (typeof fs?.readFileSync !== 'function') return null;
    return JSON.parse(
      fs.readFileSync(`${cwd}/content/banks/${packId}/${partId}.json`, 'utf8'),
    ) as unknown;
  } catch {
    return null;
  }
}

export function loadBank(packId: string, partId: string): Bank | null {
  const key = `${packId}/${partId}`;
  if (bankCache.has(key)) return bankCache.get(key) ?? null;
  let bank: Bank | null = null;
  try {
    const raw: unknown = bankFiles ? (bankFiles[key] ?? null) : readBankDisk(packId, partId);
    if (raw) {
      const parsed = BankFileSchema.parse(raw);
      if (parsed.packId === packId && parsed.partId === partId) bank = parsed as Bank;
    }
  } catch {
    bank = null;
  }
  bankCache.set(key, bank);
  return bank;
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
