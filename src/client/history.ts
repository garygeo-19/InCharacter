// Local history and settings (§4.1, §4.9). Scores and asked question ids
// stay on the device; transcripts and audio never do (§11.4).

export type Settings = {
  mode: 'typed' | 'voice';
  peekStyle: 'hold' | 'tap';
  sound: boolean;
  liveCaptions: boolean;
};

export type AttemptRecord = {
  packId: string;
  packName: string;
  partId: string;
  partTitle: string;
  icon?: string;
  best: number;
  stars: number;
  lastTaught: string;
  asked: string[][];
};

const SETTINGS_KEY = 'ic-settings';
const HISTORY_KEY = 'ic-history';

const DEFAULT_SETTINGS: Settings = { mode: 'typed', peekStyle: 'hold', sound: true, liveCaptions: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadHistory(): AttemptRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as AttemptRecord[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Record a finished class: best score wins, asked ids keep the last two. */
export function recordAttempt(input: {
  packId: string;
  packName: string;
  partId: string;
  partTitle: string;
  icon?: string;
  total: number;
  stars: number;
  askedIds: string[];
}): AttemptRecord[] {
  const history = loadHistory();
  const prev = history.find((h) => h.packId === input.packId && h.partId === input.partId);
  const asked = [...(prev?.asked ?? []), input.askedIds].slice(-2);
  const best = Math.max(prev?.best ?? 0, input.total);
  const next: AttemptRecord = {
    packId: input.packId,
    packName: input.packName,
    partId: input.partId,
    partTitle: input.partTitle,
    icon: input.icon ?? prev?.icon,
    best,
    stars: input.total >= best ? input.stars : (prev?.stars ?? input.stars),
    lastTaught: new Date().toISOString(),
    asked,
  };
  const rest = history.filter((h) => !(h.packId === input.packId && h.partId === input.partId));
  const out = [next, ...rest];
  localStorage.setItem(HISTORY_KEY, JSON.stringify(out));
  return out;
}

/** Questions asked in this part's last two attempts: never pick them (§9.2). */
export function excludeIds(history: AttemptRecord[], packId: string, partId: string): string[] {
  const prev = history.find((h) => h.packId === packId && h.partId === partId);
  return [...new Set((prev?.asked ?? []).flat())];
}

export function bestFor(history: AttemptRecord[], packId: string, partId: string): number | null {
  const prev = history.find((h) => h.packId === packId && h.partId === partId);
  return prev ? prev.best : null;
}

export function clearHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
}
