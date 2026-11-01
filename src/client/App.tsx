import { useEffect, useMemo, useRef, useState } from 'react';
import comingSoon from '../../content/coming-soon.json';
import roles from '../../content/roles.json';
import { friendlyErrorMessage } from '../shared/errors';
import { CastRow, ClassroomFigure } from './art';
import { buildNotes, PackSchema, stripPrefix } from '../shared/notes';
import { SCORING_CONFIG } from '../shared/scoring-config';
import { api, type CatalogPack, type PartsResponse, type SessionRole } from './api';
import { Segments, languageName, mmss } from './format';
import { ensureAudioContext, unlockAudioPlayback } from './voice';
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
import { Session } from './Session';
import { ModePicker } from './mode';
import './styles.css';

type View =
  | { name: 'home' }
  | { name: 'pack'; packId: string }
  | { name: 'list'; packId: string }
  | { name: 'briefing'; packId: string; partId: string; attempt: number }
  | { name: 'teach'; packId: string; partId: string; attempt: number }
  | { name: 'session-list'; packId: string; role: SessionRole }
  | { name: 'session'; packId: string; partId: string; role: SessionRole; attempt: number };

const ROLE_ORDER: SessionRole[] = ['coach', 'travel'];

function roleTile(role: SessionRole): { title: string; subtitle: string } {
  return (roles as Record<SessionRole, { title: string; subtitle: string }>)[role];
}

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
  const [catalogSeq, setCatalogSeq] = useState(0);
  const [partsCache, setPartsCache] = useState<Record<string, PartsResponse>>({});
  const [history, setHistory] = useState<AttemptRecord[]>(() => loadHistory());
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);
  const sheetDoneRef = useRef<HTMLButtonElement | null>(null);

  const closeSettings = () => {
    setSettingsOpen(false);
    settingsBtnRef.current?.focus();
  };

  useEffect(() => {
    if (!settingsOpen) return;
    sheetDoneRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.catalog().then((d) => setCatalog(d.packs)).catch((e: Error) => setCatalogError(e.message));
  }, [catalogSeq]); // eslint-disable-line react-hooks/exhaustive-deps

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
          ref={settingsBtnRef}
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </nav>

      {view.name === 'home' && (
        <Home
          catalog={catalog} catalogError={catalogError} query={query} setQuery={setQuery}
          history={history} partsCache={partsCache} partsFor={partsFor}
          onRetryCatalog={() => {
            setCatalogError(null);
            setCatalogSeq((s) => s + 1);
          }}
          onOpenPack={(packId) => setView({ name: 'pack', packId })}
          onTeachAgain={(h) => setView({ name: 'briefing', packId: h.packId, partId: h.partId, attempt: Date.now() })}
          onPlayAgain={(h) => setView({
            name: 'session', packId: h.packId, partId: h.partId,
            role: h.role === 'travel' ? 'travel' : 'coach', attempt: Date.now(),
          })}
          onNextClass={(h) => setView({ name: 'list', packId: h.packId })}
        />
      )}
      {view.name === 'pack' && (
        <PackView
          packId={view.packId} catalog={catalog} partsCache={partsCache} partsFor={partsFor}
          onBack={() => setView({ name: 'home' })}
          onTeach={() => setView({ name: 'list', packId: view.packId })}
          onRole={(role) => setView({ name: 'session-list', packId: view.packId, role })}
        />
      )}
      {view.name === 'session-list' && (
        <SessionList
          packId={view.packId} role={view.role} catalog={catalog} history={history}
          partsCache={partsCache} partsFor={partsFor}
          onBack={() => setView({ name: 'pack', packId: view.packId })}
          onOpenPart={(partId) => setView({
            name: 'session', packId: view.packId, partId, role: view.role, attempt: Date.now(),
          })}
        />
      )}
      {view.name === 'session' && (
        <Session
          key={`${view.packId}/${view.partId}/${view.role}/${view.attempt}`}
          packId={view.packId} partId={view.partId} role={view.role} catalog={catalog}
          settings={settings} updateSettings={updateSettings}
          history={history} setHistory={setHistory} fast={FAST}
          onExit={() => setView({ name: 'home' })}
          onMoreSessions={() => setView({ name: 'session-list', packId: view.packId, role: view.role })}
          onRetry={() => setView({
            name: 'session', packId: view.packId, partId: view.partId,
            role: view.role, attempt: Date.now(),
          })}
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
        <div className="sheet-backdrop" onClick={closeSettings}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
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
            <label className="check">
              <input
                type="checkbox" checked={settings.liveCaptions}
                onChange={(e) => updateSettings({ ...settings, liveCaptions: e.target.checked })}
              />
              Live captions
            </label>
            <button
              type="button" className="secondary"
              onClick={() => { clearHistory(); setHistory([]); }}
            >
              Clear my history
            </button>
            <button type="button" className="primary" ref={sheetDoneRef} onClick={closeSettings}>
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
  onRetryCatalog: () => void;
  onOpenPack: (packId: string) => void;
  onTeachAgain: (h: AttemptRecord) => void;
  onPlayAgain: (h: AttemptRecord) => void;
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
        <h1>Experience it to learn it.</h1>
      </header>

      {props.history.length > 0 && (
        <section aria-label="Keep teaching">
          <h2>Keep teaching</h2>
          <div className="cards">
            {props.history.slice(0, 3).map((h) => {
              const role = h.role ?? 'teach';
              const again = role === 'teach' ? props.onTeachAgain : props.onPlayAgain;
              return (
                <div className="card" key={`${h.packId}/${h.partId}/${role}`}>
                  <p className="card-title">{h.icon} {h.partTitle}</p>
                  <p className="fine">Best {h.best}</p>
                  <div className="row">
                    <button type="button" className="secondary" onClick={() => again(h)}>
                      {role === 'teach' ? 'Teach again' : 'Play again'}
                    </button>
                    <button type="button" className="secondary" onClick={() => props.onNextClass(h)}>
                      Next class
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section aria-label="What do you want to learn?">
        <h2>What do you want to learn?</h2>
        <input
          type="search" aria-label="Search packs" placeholder="Search packs"
          value={props.query} onChange={(e) => props.setQuery(e.target.value)}
        />
        {props.catalogError && (
          <>
            <p className="error">Couldn&apos;t load the catalog: {friendlyErrorMessage(props.catalogError)}</p>
            <button type="button" className="secondary" onClick={props.onRetryCatalog}>
              Try again
            </button>
          </>
        )}
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
  onRole: (role: SessionRole) => void;
}) {
  const pack = usePack(props.packId, props.catalog);
  const [ready, setReady] = useState<number | null>(null);
  const [roleReady, setRoleReady] = useState<Record<SessionRole, number> | null>(null);
  useEffect(() => {
    props.partsFor(props.packId)
      .then((parts) => {
        const all = parts.lessons.flatMap((l) => l.parts);
        setReady(all.filter((x) => x.teachable && x.ready).length);
        setRoleReady({
          coach: all.filter((x) => x.sessions?.coach).length,
          travel: all.filter((x) => x.sessions?.travel).length,
        });
      })
      .catch(() => {
        setReady(0);
        setRoleReady({ coach: 0, travel: 0 });
      });
  }, [props.packId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pack) return <p>Loading…</p>;
  // A usable session replaces that pack's "coming soon" tile (§16.1).
  const soonTitles = comingSoonFor(pack.id);
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
      {ROLE_ORDER.map((role) => {
        const tile = roleTile(role);
        const count = roleReady?.[role] ?? 0;
        if (roleReady && count > 0) {
          return (
            <button type="button" className="tile primary-tile" key={role} onClick={() => props.onRole(role)}>
              <strong>{tile.title}</strong>
              <span className="fine">{tile.subtitle}</span>
              <span className="fine">{count} session{count === 1 ? '' : 's'} ready</span>
            </button>
          );
        }
        if (!soonTitles.includes(tile.title)) return null;
        return (
          <div className="tile soon" key={role} aria-disabled>
            <strong>{tile.title}</strong>
            <span className="fine">Coming soon</span>
          </div>
        );
      })}
      {soonTitles
        .filter((t) => !ROLE_ORDER.some((r) => roleTile(r).title === t))
        .map((title) => (
          <div className="tile soon" key={title} aria-disabled>
            <strong>{title}</strong>
            <span className="fine">Coming soon</span>
          </div>
        ))}
    </>
  );
}

function SessionList(props: {
  packId: string;
  role: SessionRole;
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
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (cached) {
      setParts(cached);
      return;
    }
    props.partsFor(props.packId).then(setParts).catch((e: Error) => setError(e.message));
  }, [props.packId, seq]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pack) return <p>Loading…</p>;
  const tile = roleTile(props.role);
  const playable = parts?.lessons.flatMap((l) =>
    l.parts.filter((p) => p.sessions?.[props.role]),
  ) ?? [];
  return (
    <>
      <button type="button" className="secondary" onClick={props.onBack}>‹ {pack.name}</button>
      <h1>{tile.title}</h1>
      <p className="lede">{tile.subtitle}</p>
      {error && (
        <>
          <p className="error">{friendlyErrorMessage(error)}</p>
          <button
            type="button" className="secondary"
            onClick={() => {
              setError(null);
              setSeq((s) => s + 1);
            }}
          >
            Try again
          </button>
        </>
      )}
      {!parts && !error && <p>Loading sessions…</p>}
      {parts && playable.length === 0 && <p>No sessions ready yet.</p>}
      {playable.length > 0 && (
        <ul className="part-list">
          {playable.map((p) => {
            const best = bestFor(props.history, props.packId, p.id, props.role);
            return (
              <li key={p.id}>
                <button
                  type="button" className="part-row"
                  onClick={() => props.onOpenPart(p.id)}
                >
                  <span className="part-title">{stripPrefix(p.title)}</span>
                  {p.blurb && <span className="fine">{p.blurb}</span>}
                  <span className="fine">
                    Ready{best !== null ? ` · best ${best}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (cached) return;
    props.partsFor(props.packId).then(setParts).catch((e: Error) => setError(e.message));
  }, [props.packId, seq]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pack) return <p>Loading…</p>;
  return (
    <>
      <button type="button" className="secondary" onClick={props.onBack}>‹ {pack.name}</button>
      <h1>Choose a class</h1>
      {error && (
        <>
          <p className="error">{friendlyErrorMessage(error)}</p>
          <button
            type="button" className="secondary"
            onClick={() => {
              setError(null);
              setSeq((s) => s + 1);
            }}
          >
            Try again
          </button>
        </>
      )}
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
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    api.pack(props.packId)
      .then((raw) => {
        const parsed = PackSchema.parse(raw);
        const found = parsed.lessons.flatMap((l) => l.parts).find((p) => p.id === props.partId);
        setTitle(stripPrefix(found?.title ?? props.partId));
        setNotes(buildNotes(parsed, props.partId));
      })
      .catch((e: Error) => setError(e.message));
  }, [props.packId, props.partId, seq]); // eslint-disable-line react-hooks/exhaustive-deps

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
        {error && (
          <>
            <p className="error">{friendlyErrorMessage(error)}</p>
            <button
              type="button" className="secondary"
              onClick={() => {
                setError(null);
                setSeq((s) => s + 1);
              }}
            >
              Try again
            </button>
          </>
        )}
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
            // Same tap unlocks capture and question playback on iOS (§4.4):
            // the AudioContext for the mic, a silent sound on the shared
            // question element for the student voices (§4.6).
            ensureAudioContext();
            unlockAudioPlayback();
            props.onStart();
          }}
        >
          Start class
        </button>
      </div>
    </>
  );
}

export function AppRoot() {
  return <App />;
}
