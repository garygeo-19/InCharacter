import { useEffect, useMemo, useState } from 'react';
import comingSoon from '../../content/coming-soon.json';
import { CastRow, ClassroomFigure } from './art';
import { buildNotes, PackSchema, stripPrefix } from '../shared/notes';
import { SCORING_CONFIG } from '../shared/scoring-config';
import { api, type CatalogPack, type PartsResponse } from './api';
import { Segments, languageName, mmss } from './format';
import { checkMic, ensureAudioContext } from './voice';
import {
  bestFor,
  clearHistory,
  loadHistory,
  loadSettings,
  saveSettings,
  type AttemptRecord,
  type Settings,
} from './history';
import { Teach } from './Teach';
import './styles.css';

type View =
  | { name: 'home' }
  | { name: 'pack'; packId: string }
  | { name: 'list'; packId: string }
  | { name: 'briefing'; packId: string; partId: string; attempt: number }
  | { name: 'teach'; packId: string; partId: string; attempt: number };

const PRIVACY =
  "What you say is sent to Meta's API to be transcribed and graded. In Character doesn't keep it. Your scores stay on this device.";

const FAST = new URLSearchParams(window.location.search).get('fast') === '1';

function comingSoonFor(packId: string): string[] {
  const out: string[] = [];
  for (const [key, tiles] of Object.entries(comingSoon as Record<string, string[]>)) {
    if (key.endsWith('*') ? packId.startsWith(key.slice(0, -1)) : packId === key) {
      out.push(...tiles);
    }
  }
  return out;
}

function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [catalog, setCatalog] = useState<CatalogPack[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [partsCache, setPartsCache] = useState<Record<string, PartsResponse>>({});
  const [history, setHistory] = useState<AttemptRecord[]>(() => loadHistory());
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.catalog().then((d) => setCatalog(d.packs)).catch((e: Error) => setCatalogError(e.message));
  }, []);

  const partsFor = async (packId: string): Promise<PartsResponse> => {
    const hit = partsCache[packId];
    if (hit) return hit;
    const fresh = await api.parts(packId);
    setPartsCache((c) => ({ ...c, [packId]: fresh }));
    return fresh;
  };

  const updateSettings = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
  };

  return (
    <main className="page">
      <nav className="topbar">
        <button type="button" className="brand" onClick={() => setView({ name: 'home' })}>
          In Character
        </button>
        <button
          type="button" className="icon-btn" aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </nav>

      {view.name === 'home' && (
        <Home
          catalog={catalog} catalogError={catalogError} query={query} setQuery={setQuery}
          history={history} partsCache={partsCache} partsFor={partsFor}
          onOpenPack={(packId) => setView({ name: 'pack', packId })}
          onTeachAgain={(h) => setView({ name: 'briefing', packId: h.packId, partId: h.partId, attempt: Date.now() })}
          onNextClass={(h) => setView({ name: 'list', packId: h.packId })}
        />
      )}
      {view.name === 'pack' && (
        <PackView
          packId={view.packId} catalog={catalog} partsCache={partsCache} partsFor={partsFor}
          onBack={() => setView({ name: 'home' })}
          onTeach={() => setView({ name: 'list', packId: view.packId })}
        />
      )}
      {view.name === 'list' && (
        <ClassList
          packId={view.packId} catalog={catalog} history={history}
          partsCache={partsCache} partsFor={partsFor}
          onBack={() => setView({ name: 'pack', packId: view.packId })}
          onOpenPart={(partId) => setView({ name: 'briefing', packId: view.packId, partId, attempt: Date.now() })}
        />
      )}
      {view.name === 'briefing' && (
        <Briefing
          packId={view.packId} partId={view.partId} catalog={catalog}
          settings={settings} updateSettings={updateSettings}
          onBack={() => setView({ name: 'list', packId: view.packId })}
          onStart={() => setView({ name: 'teach', packId: view.packId, partId: view.partId, attempt: view.attempt })}
        />
      )}
      {view.name === 'teach' && (
        <Teach
          key={`${view.packId}/${view.partId}/${view.attempt}`}
          packId={view.packId} partId={view.partId} catalog={catalog}
          settings={settings} history={history} setHistory={setHistory} fast={FAST}
          onExit={() => setView({ name: 'home' })}
          onNextClass={() => setView({ name: 'list', packId: view.packId })}
          onTeachAgain={() => setView({ name: 'briefing', packId: view.packId, partId: view.partId, attempt: Date.now() })}
        />
      )}

      {settingsOpen && (
        <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="sheet" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
            <h2>Settings</h2>
            <label className="field">
              Default mode
              <select
                value={settings.mode}
                onChange={(e) => updateSettings({ ...settings, mode: e.target.value as Settings['mode'] })}
              >
                <option value="typed">Type (mic off)</option>
                <option value="voice">Voice</option>
              </select>
            </label>
            <label className="field">
              Peek style
              <select
                value={settings.peekStyle}
                onChange={(e) => updateSettings({ ...settings, peekStyle: e.target.value as Settings['peekStyle'] })}
              >
                <option value="hold">Press and hold</option>
                <option value="tap">Tap to open and close</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox" checked={settings.sound}
                onChange={(e) => updateSettings({ ...settings, sound: e.target.checked })}
              />
              Sound on
            </label>
            <button
              type="button" className="secondary"
              onClick={() => { clearHistory(); setHistory([]); }}
            >
              Clear my history
            </button>
            <button type="button" className="primary" onClick={() => setSettingsOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      <footer className="footer">
        <p>
          Lessons from <a href="https://flashfeedlearningapp.com">FlashFeed</a> · {PRIVACY} Student
          voices are AI-generated.
        </p>
      </footer>
    </main>
  );
}

function Home(props: {
  catalog: CatalogPack[] | null;
  catalogError: string | null;
  query: string;
  setQuery: (q: string) => void;
  history: AttemptRecord[];
  partsCache: Record<string, PartsResponse>;
  partsFor: (packId: string) => Promise<PartsResponse>;
  onOpenPack: (packId: string) => void;
  onTeachAgain: (h: AttemptRecord) => void;
  onNextClass: (h: AttemptRecord) => void;
}) {
  const { catalog } = props;
  const [readyCounts, setReadyCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!catalog) return;
    let live = true;
    void Promise.all(
      catalog.map((p) =>
        props.partsFor(p.id)
          .then((parts) => {
            if (!live) return;
            const n = parts.lessons.flatMap((l) => l.parts).filter((x) => x.teachable && x.ready).length;
            setReadyCounts((c) => (c[p.id] === n ? c : { ...c, [p.id]: n }));
          })
          .catch(() => {}),
      ),
    );
    return () => { live = false; };
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const packs = useMemo(() => {
    const q = props.query.trim().toLowerCase();
    const list = (catalog ?? []).filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q),
    );
    return [...list].sort((a, b) => (readyCounts[b.id] ?? 0) - (readyCounts[a.id] ?? 0));
  }, [catalog, props.query, readyCounts]);

  return (
    <>
      <header className="masthead">
        <h1>Teach it to learn it.</h1>
      </header>

      {props.history.length > 0 && (
        <section aria-label="Keep teaching">
          <h2>Keep teaching</h2>
          <div className="cards">
            {props.history.slice(0, 3).map((h) => (
              <div className="card" key={`${h.packId}/${h.partId}`}>
                <p className="card-title">{h.icon} {h.partTitle}</p>
                <p className="fine">Best {h.best}</p>
                <div className="row">
                  <button type="button" className="secondary" onClick={() => props.onTeachAgain(h)}>
                    Teach again
                  </button>
                  <button type="button" className="secondary" onClick={() => props.onNextClass(h)}>
                    Next class
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-label="What do you want to learn?">
        <h2>What do you want to learn?</h2>
        <input
          type="search" aria-label="Search packs" placeholder="Search packs"
          value={props.query} onChange={(e) => props.setQuery(e.target.value)}
        />
        {props.catalogError && <p className="error">Couldn&apos;t load the catalog: {props.catalogError}</p>}
        {!catalog && !props.catalogError && <p>Loading packs…</p>}
        <ul className="pack-list">
          {packs.map((p) => (
            <li key={p.id}>
              <button type="button" className="pack-row" onClick={() => props.onOpenPack(p.id)}>
                <span className="pack-icon" aria-hidden>{p.icon ?? '📚'}</span>
                <span className="pack-name">{p.name}</span>
                <span className="fine">
                  {readyCounts[p.id] === undefined
                    ? '…'
                    : readyCounts[p.id] > 0
                      ? `${readyCounts[p.id]} classes ready`
                      : 'Classes coming soon'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function usePack(packId: string, catalog: CatalogPack[] | null) {
  return (catalog ?? []).find((p) => p.id === packId) ?? null;
}

function PackView(props: {
  packId: string;
  catalog: CatalogPack[] | null;
  partsCache: Record<string, PartsResponse>;
  partsFor: (packId: string) => Promise<PartsResponse>;
  onBack: () => void;
  onTeach: () => void;
}) {
  const pack = usePack(props.packId, props.catalog);
  const [ready, setReady] = useState<number | null>(null);
  useEffect(() => {
    props.partsFor(props.packId)
      .then((parts) => setReady(parts.lessons.flatMap((l) => l.parts).filter((x) => x.teachable && x.ready).length))
      .catch(() => setReady(0));
  }, [props.packId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pack) return <p>Loading…</p>;
  return (
    <>
      <button type="button" className="secondary" onClick={props.onBack}>‹ Packs</button>
      <header>
        <h1>{pack.icon} {pack.name}</h1>
        {pack.description && <p className="lede">{pack.description}</p>}
      </header>
      <button type="button" className="tile primary-tile" onClick={props.onTeach}>
        <strong>Teach a class</strong>
        <span className="fine">You teach. Four students listen. Three ask questions.</span>
        {ready !== null && <span className="fine">{ready} classes ready</span>}
      </button>
      {comingSoonFor(pack.id).map((title) => (
        <div className="tile soon" key={title} aria-disabled>
          <strong>{title}</strong>
          <span className="fine">Coming soon</span>
        </div>
      ))}
    </>
  );
}

function ClassList(props: {
  packId: string;
  catalog: CatalogPack[] | null;
  history: AttemptRecord[];
  partsCache: Record<string, PartsResponse>;
  partsFor: (packId: string) => Promise<PartsResponse>;
  onBack: () => void;
  onOpenPart: (partId: string) => void;
}) {
  const pack = usePack(props.packId, props.catalog);
  const cached = props.partsCache[props.packId] ?? null;
  const [parts, setParts] = useState<PartsResponse | null>(cached);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (cached) return;
    props.partsFor(props.packId).then(setParts).catch((e: Error) => setError(e.message));
  }, [props.packId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pack) return <p>Loading…</p>;
  return (
    <>
      <button type="button" className="secondary" onClick={props.onBack}>‹ {pack.name}</button>
      <h1>Choose a class</h1>
      {error && <p className="error">{error}</p>}
      {!parts && !error && <p>Loading classes…</p>}
      {parts?.lessons.map((lesson) => (
        <section key={lesson.id} aria-label={stripPrefix(lesson.title)}>
          <h2>{stripPrefix(lesson.title)}</h2>
          <ul className="part-list">
            {lesson.parts.filter((p) => p.teachable).map((p) => {
              const best = bestFor(props.history, props.packId, p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button" className="part-row" disabled={!p.ready}
                    onClick={() => props.onOpenPart(p.id)}
                  >
                    <span className="part-title">{stripPrefix(p.title)}</span>
                    {p.blurb && <span className="fine">{p.blurb}</span>}
                    <span className="fine">
                      {p.noteCount} notes ·{' '}
                      {p.ready ? `Ready${best !== null ? ` · best ${best}` : ''}` : 'Coming soon'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

function Briefing(props: {
  packId: string;
  partId: string;
  catalog: CatalogPack[] | null;
  settings: Settings;
  updateSettings: (s: Settings) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const pack = usePack(props.packId, props.catalog);
  const [notes, setNotes] = useState<{ label: string; text: string }[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.pack(props.packId)
      .then((raw) => {
        const parsed = PackSchema.parse(raw);
        const found = parsed.lessons.flatMap((l) => l.parts).find((p) => p.id === props.partId);
        setTitle(stripPrefix(found?.title ?? props.partId));
        setNotes(buildNotes(parsed, props.partId));
      })
      .catch((e: Error) => setError(e.message));
  }, [props.packId, props.partId]);

  const roleLine = pack && pack.language !== 'en' && pack.language !== 'en-US' ? (
    <p className="role">You&apos;re the {languageName(pack.language)} teacher. Today&apos;s class: <strong>{title}</strong>.</p>
  ) : (
    <p className="role">You&apos;re the teacher. Today&apos;s class: <strong>{title}</strong>{pack ? `, from ${pack.name}` : ''}.</p>
  );

  return (
    <>
      <button type="button" className="secondary" onClick={props.onBack}>‹ Classes</button>
      {roleLine}
      <ClassroomFigure label="Your class" />
      <CastRow />
      <section aria-label="How it works">
        <p>Study the notes. Teach for {mmss(SCORING_CONFIG.classSeconds.typed).replace(':', ' min ')} min, then answer three questions.</p>
        <p>Peeking at your notes during class costs points.</p>
      </section>
      <section aria-label="Notes">
        <h2>Notes</h2>
        {error && <p className="error">{error}</p>}
        {!notes && !error && <p>Loading notes…</p>}
        <ul className="notes">
          {(notes ?? []).map((n) => (
            <li key={n.label}>
              <strong>{n.label}</strong>
              <p><Segments text={n.text} /></p>
            </li>
          ))}
        </ul>
      </section>
      <ModePicker
        settings={props.settings} updateSettings={props.updateSettings}
      />
      <p className="fine">{PRIVACY}</p>
      <div className="sticky-action">
        <button
          type="button" className="primary"
          disabled={!notes}
          onClick={() => {
            ensureAudioContext();
            props.onStart();
          }}
        >
          Start class
        </button>
      </div>
    </>
  );
}

// Mode choice with the §4.4 mic check: permission prompt, then a 2-second
// level meter. Denial falls back to Type and says so.
function ModePicker(props: {
  settings: Settings;
  updateSettings: (s: Settings) => void;
}) {
  const [mic, setMic] = useState<'idle' | 'checking' | 'denied'>('idle');
  const [level, setLevel] = useState(0);

  const chooseVoice = () => {
    setMic('checking');
    setLevel(0);
    checkMic(setLevel)
      .then(() => {
        setMic('idle');
        props.updateSettings({ ...props.settings, mode: 'voice' });
      })
      .catch(() => setMic('denied'));
  };

  return (
    <section aria-label="Mode">
      <h2>Mode</h2>
      <div className="row" role="radiogroup" aria-label="Mode">
        <button
          type="button" aria-pressed={props.settings.mode === 'typed'}
          className="secondary"
          onClick={() => props.updateSettings({ ...props.settings, mode: 'typed' })}
        >
          Type (mic off){props.settings.mode === 'typed' ? ' ✓' : ''}
        </button>
        <button
          type="button" aria-pressed={props.settings.mode === 'voice'}
          className="secondary" disabled={mic === 'checking'}
          onClick={chooseVoice}
        >
          Voice{props.settings.mode === 'voice' ? ' ✓' : ''}
        </button>
      </div>
      {mic === 'checking' && (
        <>
          <p className="fine" role="status">Listening — speak to test your mic…</p>
          <div className="meter" aria-hidden>
            <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        </>
      )}
      {mic === 'denied' && (
        <p className="error" role="status">Mic unavailable — using Type instead.</p>
      )}
    </section>
  );
}

export function AppRoot() {
  return <App />;
}
