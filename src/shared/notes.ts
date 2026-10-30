import { z } from 'zod';
import { sha256Hex } from './sha256';

// REQUIREMENTS.md §6.1: validate only the fields below, ignore everything else
// (zod objects strip unknown keys by default).

export const CatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string().optional(),
  icon: z.string().optional(),
  version: z.string(),
  contentHash: z.string(),
  description: z.string().optional(),
  language: z.string(),
  url: z.string(),
  lessonCount: z.number(),
  cardCount: z.number(),
  status: z.string().optional(),
  healthNotice: z.boolean().optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

const CatalogSchema = z.object({
  catalogVersion: z.number().optional(),
  generatedAt: z.string().optional(),
  packs: z.array(CatalogEntrySchema),
});

const TextSchema = z.object({
  modality: z.string(),
  value: z.string(),
  short: z.string().optional(),
});

const SpeakSchema = z.object({ text: z.string(), lang: z.string() });

const FactItemSchema = z.object({
  id: z.string(),
  shape: z.literal('fact'),
  title: z.string(),
  body: z.string(),
  imageCaption: z.string().optional(),
  speak: SpeakSchema.optional(),
});

const DefinitionItemSchema = z.object({
  id: z.string(),
  shape: z.literal('definition'),
  term: TextSchema,
  definition: TextSchema,
});

const PairItemSchema = z.object({
  id: z.string(),
  shape: z.literal('pair'),
  sideA: TextSchema,
  sideB: TextSchema,
  speak: SpeakSchema.optional(),
});

const OtherItemSchema = z.object({ id: z.string(), shape: z.string() });

const ItemSchema = z.union([FactItemSchema, DefinitionItemSchema, PairItemSchema, OtherItemSchema]);

export type FactItem = z.infer<typeof FactItemSchema>;
export type DefinitionItem = z.infer<typeof DefinitionItemSchema>;
export type PairItem = z.infer<typeof PairItemSchema>;
export type Item = z.infer<typeof ItemSchema>;

// The catch-all quiz shape keeps `shape: string`, so literal comparisons
// don't narrow the zod union; these guards do.
export function isFact(item: Item): item is FactItem {
  return item.shape === 'fact';
}
export function isDefinition(item: Item): item is DefinitionItem {
  return item.shape === 'definition';
}
export function isPair(item: Item): item is PairItem {
  return item.shape === 'pair';
}

const PartSchema = z.object({
  id: z.string(),
  title: z.string(),
  blurb: z.string().optional(),
  itemIds: z.array(z.string()),
});
export type Part = z.infer<typeof PartSchema>;

const LessonSchema = z.object({
  id: z.string(),
  title: z.string(),
  order: z.number(),
  parts: z.array(PartSchema),
  objectives: z.array(z.object({ id: z.string(), statement: z.string() })).optional().default([]),
});
export type Lesson = z.infer<typeof LessonSchema>;

export const PackSchema = z.object({
  packId: z.string(),
  packName: z.string(),
  packVersion: z.string(),
  language: z.string(),
  lessons: z.array(LessonSchema),
  items: z.array(ItemSchema),
});
export type Pack = z.infer<typeof PackSchema>;

export const CATALOG_DEFAULT = 'https://flashfeed-packs-serving.vercel.app';

// --- Catalog / pack loading (§6.1) -------------------------------------------

const catalogCache = new Map<string, CatalogEntry[]>();
const packCache = new Map<string, Pack>();

/** Live packs only: status === "ga" and no healthNotice (§6.1). */
export function liveEntries(packs: CatalogEntry[]): CatalogEntry[] {
  return packs.filter((p) => p.status === 'ga' && p.healthNotice !== true);
}

export async function fetchCatalog(base: string = CATALOG_DEFAULT): Promise<CatalogEntry[]> {
  const hit = catalogCache.get(base);
  if (hit) return hit;
  const res = await fetch(`${base}/packs/catalog.json`);
  if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);
  const entries = liveEntries(CatalogSchema.parse(await res.json()).packs);
  catalogCache.set(base, entries);
  return entries;
}

/** Packs are cached by id@version: a version never changes (§6.1). */
export async function fetchPack(base: string, entry: CatalogEntry): Promise<Pack> {
  const key = `${entry.id}@${entry.version}`;
  const hit = packCache.get(key);
  if (hit) return hit;
  const res = await fetch(`${base}${entry.url}`);
  if (!res.ok) throw new Error(`Pack fetch failed: ${res.status}`);
  const pack = PackSchema.parse(await res.json());
  packCache.set(key, pack);
  return pack;
}

export function clearCacheForTests(): void {
  catalogCache.clear();
  packCache.clear();
}

// --- Notes (§6.3) --------------------------------------------------------------

export type NoteKind = 'fact' | 'definition' | 'word';

export type Note = {
  id: string;
  kind: NoteKind;
  label: string;
  text: string;
  weight: number;
  anchors: string[];
  evidenceWords: string[];
  hash: string;
};

/** Strip "Part N: " / "Lesson N: " prefixes for display (§6.3). */
export function stripPrefix(title: string): string {
  return title.replace(/^(Part|Lesson) \d+:\s*/, '');
}

function cleanAnchor(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[.…!?,;:)"'\]]+$/u, '')
    .trim();
}

// A single-quoted phrase opens with ' after a space, a bracket or the start
// of the text, so the apostrophe in "don't" isn't one (§6.3).
const QUOTED_RE = /(?:^|[\s([{])'([^']+)'/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;

function quotedPhrases(body: string): string[] {
  const out: string[] = [];
  QUOTED_RE.lastIndex = 0;
  for (let m = QUOTED_RE.exec(body); m; m = QUOTED_RE.exec(body)) out.push(m[1]);
  return out;
}

function spans(body: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) out.push(m[1]);
  return out;
}

function dedupe(anchors: string[]): string[] {
  const seen = new Set<string>();
  return anchors
    .map(cleanAnchor)
    .filter((a) => a.length > 0 && !seen.has(a) && (seen.add(a), true));
}

/** Anchors in §6.3 order: speak.text, bold spans, italic spans, quoted phrases. */
export function anchorsForItem(item: Item): string[] {
  if (isDefinition(item)) return dedupe([item.term.value]);
  if (isPair(item)) {
    return dedupe([item.sideA.value, item.speak?.text ?? '']);
  }
  // fact (quiz shapes carry no anchors)
  if (!isFact(item)) return [];
  const bolds = spans(item.body, BOLD_RE);
  const withoutBolds = item.body.replace(BOLD_RE, ' ');
  const italics = spans(withoutBolds, ITALIC_RE);
  return dedupe([item.speak?.text ?? '', ...bolds, ...italics, ...quotedPhrases(item.body)]);
}

// Common English/Spanish function words excluded from evidence words (§6.3).
// Fixed list (Decision 30 Oct 2026): the spec's list is open-ended ("and so on").
const STOPWORDS = new Set(
  `a,an,and,are,as,at,be,been,being,but,by,can,could,does,did,do,for,from,had,has,have,how,into,is,it,its,like,more,most,not,of,on,only,or,other,over,said,say,should,so,such,than,that,the,their,them,then,there,these,they,this,those,through,under,very,was,were,what,when,where,which,who,will,with,would,you,your,about,after,also,before,between,just,mean,means,word,words
   el,la,los,las,un,una,unos,unas,del,al,de,en,y,o,que,con,por,para,como,pero,esta,este,estos,estas,ese,esa,eso,aquel,mi,mis,tu,tus,su,sus,entre,sobre,desde,hasta,donde,cuando,porque,está,están,ser,son,sin,hay,más,muy,mucho,mucha,muchos,muchas,todo,toda,todos,todas,hace,hacer,puede,pueden,tiene,tienen`
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean),
);

/** Distinctive words of a note's anchors, label and text after normalization. */
export function evidenceWordsFor(anchors: string[], label: string, text: string): string[] {
  const words = normalize(`${anchors.join(' ')}\n${label}\n${text}`)
    .split(' ')
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    if (/\d/.test(w) || (w.length >= 4 && !STOPWORDS.has(w))) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/** Note hash: sha256(kind + "\n" + label + "\n" + text) (§6.3). */
export function noteHash(kind: NoteKind, label: string, text: string): string {
  return sha256Hex(`${kind}\n${label}\n${text}`);
}

function textSide(t: { modality: string; value: string } | undefined): string | null {
  if (!t || t.modality !== 'text' || !t.value) return null;
  return t.value;
}

/** Build the part's notes word for word (§6.3). Facts/definitions first in
 *  itemIds order, then words. Quiz shapes are skipped. */
export function buildNotes(pack: Pack, partId: string): Note[] {
  const part = pack.lessons.flatMap((l) => l.parts).find((p) => p.id === partId);
  if (!part) throw new Error(`Unknown part: ${partId}`);
  const items = new Map(pack.items.map((i) => [i.id, i]));
  const heads: Note[] = [];
  const words: Note[] = [];
  for (const id of part.itemIds) {
    const item = items.get(id);
    if (!item) continue;
    if (isFact(item)) {
        const text = item.imageCaption ? `${item.body}\n${item.imageCaption}` : item.body;
        const anchors = anchorsForItem(item);
        heads.push({
          id: item.id, kind: 'fact', label: item.title, text, weight: 2,
          anchors, evidenceWords: evidenceWordsFor(anchors, item.title, text),
          hash: noteHash('fact', item.title, text),
        });
      } else if (isDefinition(item)) {
        const anchors = anchorsForItem(item);
        heads.push({
          id: item.id, kind: 'definition', label: item.term.value, text: item.definition.value,
          weight: 2, anchors,
          evidenceWords: evidenceWordsFor(anchors, item.term.value, item.definition.value),
          hash: noteHash('definition', item.term.value, item.definition.value),
        });
      } else if (isPair(item)) {
        const a = textSide(item.sideA);
        const b = textSide(item.sideB);
        if (a === null || b === null) continue;
        const text = `${a} — ${b}`;
        const anchors = anchorsForItem(item);
        words.push({
          id: item.id, kind: 'word', label: a, text, weight: 1,
          anchors, evidenceWords: evidenceWordsFor(anchors, a, text),
          hash: noteHash('word', a, text),
        });
      }
      // quiz shapes (mcq, trueFalse, cloze, concept, …): skipped
  }
  return [...heads, ...words];
}

/** A part is teachable with 4–12 notes and at least one fact/definition (§6.2). */
export function isTeachable(notes: Note[]): boolean {
  return notes.length >= 4 && notes.length <= 12 && notes.some((n) => n.kind !== 'word');
}

// --- Outline (§6.4) ------------------------------------------------------------

export type Outline = { facts: { id: string; label: string }[]; words: { id: string; label: string }[] };

/** Labels only: facts/definitions first, then a "Words" group (side A only). */
export function buildOutline(notes: Note[]): Outline {
  const facts = notes.filter((n) => n.kind !== 'word').map((n) => ({ id: n.id, label: n.label }));
  const words = notes.filter((n) => n.kind === 'word').map((n) => ({ id: n.id, label: n.label }));
  return { facts, words };
}

// --- Normalization (§8.5 rule 1; here so banks, picker and client share it) ---

/** NFD → strip accents → lowercase → non [a-z0-9 ] to space → collapse/trim. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

// --- Inline **bold** / *italic* segments for rendering (display only) ---------

export type Segment = { text: string; bold?: boolean; italic?: boolean };

export function renderSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
