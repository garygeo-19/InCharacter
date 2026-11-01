import { useEffect, useMemo, useRef, useState } from 'react';
import { friendlyErrorMessage } from '../shared/errors';
import {
  QUESTION_CAPTION_FALLBACK_MS,
  questionAudioAfter,
  questionAudioMode,
} from '../shared/question-audio';
import { TimedTurn } from '../shared/timed-turn';
import { splitTextToLines } from '../shared/lines';
import { buildNotes, buildOutline, PackSchema, stripPrefix, type Note } from '../shared/notes';
import { SCORING_CONFIG } from '../shared/scoring-config';
import { formatPoints, headlineFor } from '../shared/scoring';
import { scoreSessionRun } from '../shared/session';
import { describeWalk, resolveLegMoves, type WalkMove } from '../shared/walk';
import { TownMap, type TownMapSpeaker } from './TownMap';
import type { Line, Peek } from '../shared/types';
import {
  api,
  type LineIn,
  type SessionDisplay,
  type SessionGrade,
  type SessionNodeDisplay,
  type SessionRole,
} from './api';
import { Segments, VerdictChip, mmss } from './format';
import { ensureAudioContext, playSharedQuestion, replaySharedQuestion, unlockAudioPlayback } from './voice';
import { recordAttempt, type AttemptRecord, type Settings } from './history';
import { OutlinePeek } from './peek';
import {
  Celebration,
  LongBox,
  QuestionAudioSlot,
  useTimerAnnouncement,
  VoiceLineTaker,
  WaitingDots,
} from './Teach';
import { ModePicker } from './mode';

// Roles (§16.3): briefing → turns → end → grading → debrief. The line audio,
// captions, Replay, peeks, timers, live captions and the celebration are the
// classroom's components; only the game-master routing and the debrief rows
// are session-specific.

type Phase =
  | { name: 'briefing' }
  | { name: 'turn'; nodeId: string; asking: boolean }
  | { name: 'thinking'; nodeId: string }
  | { name: 'grading' }
  | { name: 'debrief' }
  | { name: 'failed'; error: string };

function speakerName(session: SessionDisplay, speakerId: string): string {
  return session.cast.find((c) => c.id === speakerId)?.name ?? speakerId;
}

export function Session(props: {
  packId: string;
  partId: string;
  role: SessionRole;
  catalog: { id: string; name: string; icon?: string }[] | null;
  settings: Settings;
  updateSettings: (s: Settings) => void;
  history: AttemptRecord[];
  setHistory: (h: AttemptRecord[]) => void;
  fast: boolean;
  onExit: () => void;
  onMoreSessions: () => void;
  onRetry: () => void;
}) {
  const pack = (props.catalog ?? []).find((p) => p.id === props.packId) ?? null;
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [partTitle, setPartTitle] = useState(props.partId);
  const [session, setSession] = useState<SessionDisplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);
  const [phase, setPhase] = useState<Phase>({ name: 'briefing' });
  const [visited, setVisited] = useState<string[]>([]);
  const [routePath, setRoutePath] = useState<string[]>([]);
  // The walking map (§16.6): one entry per transition taken, in order. The
  // moves come from the route the game master chose (or stay put on the
  // default); the trail is drawn only from these.
  const [trail, setTrail] = useState<{ nodeId: string; moves: WalkMove[] }[]>([]);
  const [answers, setAnswers] = useState<{ nodeId: string; lines: Line[] }[]>([]);
  const [peeks, setPeeks] = useState<Peek[]>([]);
  const [grade, setGrade] = useState<SessionGrade | null>(null);
  const [gradeAttempts, setGradeAttempts] = useState(0);

  const answerSecs = props.fast ? 8 : SCORING_CONFIG.answerSeconds[props.settings.mode];

  useEffect(() => {
    let live = true;
    api.pack(props.packId)
      .then((raw) => {
        if (!live) return;
        setNotes(buildNotes(PackSchema.parse(raw), props.partId));
      })
      .catch((e: Error) => live && setError(e.message));
    api.session(props.packId, props.partId, props.role)
      .then((d) => live && setSession(d))
      .catch((e: Error) => live && setError(e.message));
    api.parts(props.packId)
      .then((d) => {
        if (!live) return;
        const found = d.lessons.flatMap((l) => l.parts).find((p) => p.id === props.partId);
        if (found) setPartTitle(stripPrefix(found.title));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [props.packId, props.partId, props.role, loadSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const outline = useMemo(() => (notes ? buildOutline(notes) : null), [notes]);
  const notesById = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  const nodesById = useMemo(
    () => new Map((session?.nodes ?? []).map((n) => [n.id, n])),
    [session],
  );
  // Walking-map trail (§16.6): legs taken so far and who was met after each.
  const trailLegs = useMemo(() => trail.map((t) => t.moves), [trail]);
  const trailSpeakers = useMemo<TownMapSpeaker[]>(
    () =>
      (session ? trail : []).map((t) => {
        const n = nodesById.get(t.nodeId);
        const cast = session?.cast.find((c) => c.id === n?.speaker);
        return {
          nodeId: t.nodeId,
          speakerId: n?.speaker ?? '',
          name: cast?.name ?? n?.speaker ?? t.nodeId,
          portrait: cast?.portrait ?? '',
          end: n?.end ?? false,
        };
      }),
    [trail, nodesById, session],
  );
  const recordPeek = (peek: Peek) => setPeeks((p) => [...p, peek]);

  // Advance past a node: end nodes go to grading, anything else asks the
  // game master for the next checked line (§16.3).
  const advanceFrom = (nodeId: string, lines: Line[] | null) => {
    const node = nodesById.get(nodeId);
    if (!node) {
      setPhase({ name: 'failed', error: 'Unknown session node.' });
      return;
    }
    if (lines) setAnswers((a) => [...a, { nodeId, lines }]);
    const nextVisited = [...visited, nodeId];
    setVisited(nextVisited);
    if (node.end) {
      setPhase({ name: 'grading' });
      return;
    }
    setPhase({ name: 'thinking', nodeId });
    const payload: { nodeId: string; lines: LineIn[] } = {
      nodeId,
      lines: (lines ?? []).map((l) => ({ n: l.n, text: l.text })),
    };
    api.turn({
      packId: props.packId, partId: props.partId,
      nodeId: payload.nodeId, lines: payload.lines, visited,
    })
      .then((t) => {
        setRoutePath((p) => [...p, t.route]);
        // Walk the moves of the route the game master chose (§16.6). The
        // display shape carries each route's moves; the default stays put.
        const cur = nodesById.get(nodeId);
        const moves = cur ? resolveLegMoves(cur.routes, t.route, t.next) : [];
        setTrail((tr) => [...tr, { nodeId: t.next, moves }]);
        setPhase({ name: 'turn', nodeId: t.next, asking: true });
      })
      .catch((e: Error) => setPhase({ name: 'failed', error: e.message }));
  };

  if (error) {
    return (
      <>
        <p className="error">{friendlyErrorMessage(error)}</p>
        <div className="sticky-action">
          <button
            type="button" className="primary"
            onClick={() => {
              setError(null);
              setLoadSeq((s) => s + 1);
            }}
          >
            Try again
          </button>
          <button type="button" className="secondary" onClick={props.onExit}>Home</button>
        </div>
      </>
    );
  }
  if (!notes || !outline || !session) {
    return (
      <>
        <p>Preparing your session…</p>
        <WaitingDots status="Preparing your session. Loading the notes and the script." />
      </>
    );
  }

  return (
    <>
      {phase.name === 'briefing' && (
        <SessionBriefing
          packName={pack?.name ?? props.packId}
          partTitle={partTitle || props.partId}
          session={session}
          notes={notes}
          settings={props.settings}
          updateSettings={props.updateSettings}
          onBack={props.onMoreSessions}
          onStart={() => {
            ensureAudioContext();
            unlockAudioPlayback();
            setTrail([]);
            setPhase({ name: 'turn', nodeId: session.start, asking: true });
          }}
        />
      )}
      {(phase.name === 'turn' || phase.name === 'thinking') && session.map && (() => {
        // The walking map (§16.6) stays mounted across turns and the
        // thinking beat (no key), so when the next leg lands the dot walks
        // it instead of jumping. The turn screen below remounts per node.
        const node = nodesById.get(phase.nodeId);
        const arrived = node?.end ?? false;
        return (
          <TownMap
            legs={trailLegs}
            speakers={trailSpeakers}
            startLabel={session.map!.start}
            goalLabel={session.map!.goal}
            showGoal={arrived}
            summary={describeWalk(trailLegs, { arrived, goal: session.map!.goal })}
          />
        );
      })()}
      {phase.name === 'turn' && (() => {
        const node = nodesById.get(phase.nodeId);
        if (!node) return <p>Loading…</p>;
        return (
          <TurnScreen
            key={phase.nodeId}
            node={node}
            speaker={speakerName(session, node.speaker)}
            portrait={session.cast.find((c) => c.id === node.speaker)?.portrait ?? ''}
            speakerDescription={session.cast.find((c) => c.id === node.speaker)?.description ?? ''}
            mode={props.settings.mode}
            soundOn={props.settings.sound}
            packId={props.packId}
            partId={props.partId}
            totalSecs={answerSecs}
            asking={phase.asking}
            outline={outline}
            noteText={(id) => notesById.get(id)?.text ?? ''}
            peekStyle={props.settings.peekStyle}
            liveCaptions={props.settings.liveCaptions}
            onPeek={recordPeek}
            onPlayed={() => advanceFrom(node.id, null)}
            onAskingDone={() => setPhase({ name: 'turn', nodeId: phase.nodeId, asking: false })}
            onAnswered={(lines) => advanceFrom(node.id, lines)}
          />
        );
      })()}
      {phase.name === 'thinking' && (
        <>
          <h2>{speakerName(session, nodesById.get(phase.nodeId)?.speaker ?? '')} is thinking…</h2>
          <WaitingDots status="The client is thinking about your reply." />
        </>
      )}
      {phase.name === 'grading' && (
        <SessionGrading
          packId={props.packId}
          partId={props.partId}
          answers={answers}
          attempts={gradeAttempts}
          onDone={(g) => {
            setGrade(g);
            setPhase({ name: 'debrief' });
          }}
          onError={(message) => setPhase({ name: 'failed', error: message })}
        />
      )}
      {phase.name === 'failed' && (
        <>
          <h1>Grading hit a snag</h1>
          <p className="lede">{friendlyErrorMessage(phase.error)}</p>
          <div className="sticky-action">
            <button
              type="button" className="primary"
              onClick={() => {
                setGradeAttempts((a) => a + 1);
                setPhase({ name: 'grading' });
              }}
            >
              Grade again
            </button>
            <button type="button" className="secondary" onClick={props.onMoreSessions}>
              Back to sessions
            </button>
          </div>
        </>
      )}
      {phase.name === 'debrief' && grade && (
        <SessionDebrief
          notes={notes}
          session={session}
          nodesById={nodesById}
          grade={grade}
          answers={answers}
          routePath={routePath}
          legs={trailLegs}
          speakers={trailSpeakers}
          peeks={peeks}
          packName={pack?.name ?? props.packId}
          icon={pack?.icon}
          onRecord={(total, stars) => {
            props.setHistory(recordAttempt({
              packId: props.packId, packName: pack?.name ?? props.packId,
              partId: props.partId, partTitle: partTitle || props.partId,
              icon: pack?.icon, total, stars,
              askedIds: answers.map((a) => a.nodeId),
              role: props.role,
            }));
          }}
          onRetry={props.onRetry}
          onMoreSessions={props.onMoreSessions}
          onExit={props.onExit}
        />
      )}
    </>
  );
}

function SceneImg({ scene, label }: { scene: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (!scene || failed) return null;
  return (
    <img
      className="scene-img"
      src={`/${scene}`}
      alt={label}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function SessionPortrait({ portrait, name, description }: { portrait: string; name: string; description: string }) {
  const [failed, setFailed] = useState(false);
  if (!portrait || failed) {
    return <span className="portrait" aria-hidden>{name[0]}</span>;
  }
  return (
    <img
      className="portrait-img"
      src={`/${portrait}`}
      alt={`${name}, ${description}`}
      width={56}
      height={56}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function SessionBriefing(props: {
  packName: string;
  partTitle: string;
  session: SessionDisplay;
  notes: Note[];
  settings: Settings;
  updateSettings: (s: Settings) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const intro =
    props.session.role === 'coach'
      ? <>Your client: {props.session.cast[0]?.name} — {props.session.brief}</>
      : <>{props.session.brief}</>;
  return (
    <>
      <button type="button" className="secondary" onClick={props.onBack}>‹ Sessions</button>
      <p className="role">{intro} <strong>{props.partTitle}</strong>{`, from ${props.packName}`}.</p>
      <div className="portrait-row" aria-label="The cast">
        {props.session.cast.map((c) => (
          <div className="portrait-cell" key={c.id}>
            <SessionPortrait portrait={c.portrait} name={c.name} description={c.description} />
            <span>{c.name}</span>
          </div>
        ))}
      </div>
      <section aria-label="How it works">
        <p>Study the notes. Coach your client through the conversation — what you say decides what happens next.</p>
        <p>Peeking at your notes during the session costs points.</p>
      </section>
      <section aria-label="Notes">
        <h2>Notes</h2>
        <ul className="notes">
          {props.notes.map((n) => (
            <li key={n.id}>
              <strong>{n.label}</strong>
              <p><Segments text={n.text} /></p>
            </li>
          ))}
        </ul>
      </section>
      <ModePicker settings={props.settings} updateSettings={props.updateSettings} />
      <p className="fine">
        What you say is sent to Meta&apos;s API to be transcribed and graded. In Character doesn&apos;t keep it.
        Your scores stay on this device. Character voices are AI-generated.
      </p>
      <div className="sticky-action">
        <button
          type="button" className="primary"
          onClick={props.onStart}
        >
          Start session
        </button>
      </div>
    </>
  );
}

// The English meaning of a Spanish line (travel) is hidden: understanding
// the Spanish is the game. "Show English" reveals it and counts as a peek
// (§5, §8.4), like peeking at a note.
function GlossPeek({ gloss, noteId, onPeek }: { gloss: string; noteId: string; onPeek: (peek: Peek) => void }) {
  const [shown, setShown] = useState(false);
  if (shown) return <p className="fine">{gloss}</p>;
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        const now = Date.now();
        onPeek({ noteId, phase: 'session', startedAt: now, endedAt: now, ms: 0 });
        setShown(true);
      }}
    >
      Show English (counts as a peek)
    </button>
  );
}

function TurnScreen(props: {
  node: SessionNodeDisplay;
  speaker: string;
  portrait: string;
  speakerDescription: string;
  mode: Settings['mode'];
  soundOn: boolean;
  packId: string;
  partId: string;
  totalSecs: number;
  asking: boolean;
  outline: ReturnType<typeof buildOutline>;
  noteText: (id: string) => string;
  peekStyle: Settings['peekStyle'];
  liveCaptions: boolean;
  onPeek: (peek: Peek) => void;
  onPlayed: () => void;
  onAskingDone: () => void;
  onAnswered: (lines: Line[]) => void;
}) {
  const { node } = props;
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const left = props.totalSecs - elapsed;
  const announcement = useTimerAnnouncement(left);
  const useVoice = props.mode === 'voice';
  const [typedFallback, setTypedFallback] = useState(false);
  const [micNotice, setMicNotice] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(true);
  const [audioFailed, setAudioFailed] = useState(false);
  const turnRef = useRef<TimedTurn | null>(null);
  if (!turnRef.current) turnRef.current = new TimedTurn();
  const [submitted, setSubmitted] = useState(false);
  const answeringVoice = useVoice && !typedFallback;
  const answeringVoiceRef = useRef(answeringVoice);
  answeringVoiceRef.current = answeringVoice;

  const finishAnswer = (reason: 'done' | 'timeout'): boolean => {
    const turn = turnRef.current!;
    if (!turn.finish(reason)) return false;
    setSubmitted(true);
    if (answeringVoiceRef.current) {
      setAnswerOpen(false);
    } else if (turn.deliver()) {
      props.onAnswered(splitTextToLines(draftRef.current));
    }
    return true;
  };
  const deliverAnswerLines = (lines: Line[]) => {
    if (turnRef.current!.deliver()) props.onAnswered(lines);
  };
  const fallBackToTyping = (notice: boolean) => {
    turnRef.current = new TimedTurn();
    setSubmitted(false);
    setTypedFallback(true);
    if (notice) setMicNotice(true);
  };

  const audioUrl = node.audioUrl;
  const audioWanted = questionAudioMode({ audioUrl, soundOn: props.soundOn });
  const audioMode = questionAudioAfter({
    mode: audioWanted,
    event: audioFailed ? 'error' : 'replayed',
  });

  // The answer timer runs once the answer has started: voice recording
  // starts then too, so the timer and the mic agree.
  useEffect(() => {
    if (props.asking || !node.reply) return undefined;
    if (!turnRef.current!.timerRunning) return undefined;
    if (left <= 0) {
      finishAnswer('timeout');
      return undefined;
    }
    const t = setTimeout(() => setElapsed((e) => e + 1), 1000);
    return () => clearTimeout(t);
  }, [left, props.asking, submitted]); // eslint-disable-line react-hooks/exhaustive-deps

  // The line plays with its caption (and gloss); the reply starts when it
  // ends, with a "Your turn" cue — or 2 s after the caption on fallback.
  useEffect(() => {
    if (!props.asking) return undefined;
    if (node.reply && !useVoice) {
      props.onAskingDone();
      return undefined;
    }
    if (audioMode === 'audio' && audioUrl) {
      return playSharedQuestion(audioUrl, {
        onEnded: () => (node.reply ? (useVoice ? props.onAskingDone() : undefined) : props.onPlayed()),
        onError: () => setAudioFailed(true),
      });
    }
    const t = setTimeout(
      () => (node.reply ? (useVoice ? props.onAskingDone() : undefined) : props.onPlayed()),
      QUESTION_CAPTION_FALLBACK_MS,
    );
    return () => clearTimeout(t);
  }, [props.asking, node.id, useVoice, audioMode, audioUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Type mode: the line audio plays alongside the already-usable answer box.
  useEffect(() => {
    if (!node.reply || useVoice || audioMode !== 'audio' || !audioUrl) return undefined;
    return playSharedQuestion(audioUrl, {
      onEnded: () => {},
      onError: () => setAudioFailed(true),
    });
  }, [node.id, useVoice, audioMode, audioUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <SceneImg scene={node.scene} label={`${props.speaker}'s scene`} />
      <div className="question">
        <SessionPortrait portrait={props.portrait} name={props.speaker} description={props.speakerDescription} />
        <div className="bubble">
          <p className="asker">{props.speaker}</p>
          <p>{node.text}</p>
          {node.gloss && <GlossPeek gloss={node.gloss} noteId={node.noteIds[0] ?? node.id} onPeek={props.onPeek} />}
          {audioWanted === 'audio' && audioUrl && (
            <>
              <QuestionAudioSlot src={audioUrl} />
              <button
                type="button" className="secondary"
                aria-label={`Replay ${props.speaker}'s line`}
                onClick={() => replaySharedQuestion(() => setAudioFailed(true))}
              >
                Replay
              </button>
            </>
          )}
        </div>
      </div>
      {!props.asking && node.reply && (
        <>
          <div className="timer" role="timer" aria-live="off">
            {mmss(left)}
          </div>
          <span className="sr-only" aria-live="polite">{announcement}</span>
          <details className="drawer">
            <summary>Outline (peek)</summary>
            <OutlinePeek
              outline={props.outline} noteText={props.noteText} phase="session"
              peekStyle={props.peekStyle} onPeek={props.onPeek}
            />
          </details>
          {answeringVoice ? (
            <>
              <p className="lede">Your turn — speak now.</p>
              {micNotice && (
                <p className="error" role="status">Mic unavailable — using Type instead.</p>
              )}
              <VoiceLineTaker
                packId={props.packId} partId={props.partId}
                active={answerOpen} cue="Coach your client — speak now."
                liveCaptions={props.liveCaptions}
                onDone={deliverAnswerLines}
                onTypeInstead={() => fallBackToTyping(false)}
                onMicUnavailable={() => fallBackToTyping(true)}
              />
              {submitted && (
                <>
                  <p role="status">Reply sent…</p>
                  <WaitingDots status="Reply sent. Transcribing your reply." />
                </>
              )}
              <div className="sticky-action">
                <button type="button" className="primary" disabled={!answerOpen || submitted} onClick={() => finishAnswer('done')}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <LongBox
                label="Type your reply"
                placeholder="Type your reply — write as much as you like"
                value={draft} onChange={setDraft}
              />
              <div className="sticky-action">
                <button
                  type="button" className="primary" disabled={submitted}
                  onClick={() => {
                    const turn = turnRef.current!;
                    if (turn.isStopped) deliverAnswerLines(splitTextToLines(draftRef.current));
                    else finishAnswer('done');
                  }}
                >
                  Done
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

function SessionGrading(props: {
  packId: string;
  partId: string;
  answers: { nodeId: string; lines: Line[] }[];
  attempts: number;
  onDone: (grade: SessionGrade) => void;
  onError: (message: string) => void;
}) {
  const fired = useRef(0);
  useEffect(() => {
    if (fired.current === props.attempts + 1) return;
    fired.current = props.attempts + 1;
    void api.gradeSession({
      packId: props.packId,
      partId: props.partId,
      answers: props.answers.map((a) => ({
        nodeId: a.nodeId,
        lines: a.lines.map((l) => ({ n: l.n, text: l.text })),
      })),
    })
      .then((g) => props.onDone(g))
      .catch((e: Error) => props.onError(e.message));
  }, [props.attempts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <h1>Grading your session…</h1>
      <p className="lede">Checking every quote against your own words.</p>
      <WaitingDots status="Grading your session. This can take a few seconds." />
    </>
  );
}

function SessionDebrief(props: {
  notes: Note[];
  session: SessionDisplay;
  nodesById: Map<string, SessionNodeDisplay>;
  grade: SessionGrade;
  answers: { nodeId: string; lines: Line[] }[];
  routePath: string[];
  legs: WalkMove[][];
  speakers: TownMapSpeaker[];
  peeks: Peek[];
  packName: string;
  icon?: string;
  onRecord: (total: number, stars: number) => void;
  onRetry: () => void;
  onMoreSessions: () => void;
  onExit: () => void;
}) {
  const notesById = useMemo(() => new Map(props.notes.map((n) => [n.id, n])), [props.notes]);

  const score = useMemo(() => {
    return scoreSessionRun({ answers: props.grade.answers, peeks: props.peeks });
  }, [props.grade, props.peeks]);

  const recorded = useRef(false);
  useEffect(() => {
    if (!recorded.current) {
      recorded.current = true;
      props.onRecord(score.total, score.stars);
    }
  }, [score]); // eslint-disable-line react-hooks/exhaustive-deps

  const headline = headlineFor(score.stars, props.session.role);

  return (
    <>
      <Celebration headline={headline} total={score.total} stars={score.stars} />
      {props.session.map && (
        <section aria-label="Your walk">
          <h2>Your walk</h2>
          <TownMap
            legs={props.legs}
            speakers={props.speakers}
            startLabel={props.session.map.start}
            goalLabel={props.session.map.goal}
            showGoal
            animate={false}
            full
            summary={describeWalk(props.legs, { arrived: true, goal: props.session.map.goal })}
          />
        </section>
      )}
      <section aria-label="How your score was calculated">
        <h2>How your score was calculated</h2>
        <ul className="breakdown">
          {score.perNode.map((s, i) => (
            <li key={i}>
              Reply {i + 1}: {formatPoints(s)} of {formatPoints(100 / score.perNode.length)}
            </li>
          ))}
          <li>Replies: {formatPoints(score.questions)} of 100</li>
          <li>
            Peeks: {props.peeks.length} peek{props.peeks.length === 1 ? '' : 's'} →{' '}
            {score.peekPenalty > 0 ? `−${formatPoints(score.peekPenalty)}` : 'no penalty'}
          </li>
          <li>
            <strong>
              Total: {formatPoints(score.questions)} − {formatPoints(score.peekPenalty)} ={' '}
              {score.total}
            </strong>
          </li>
        </ul>
      </section>

      <section aria-label="Your replies">
        <h2>Your replies</h2>
        {props.grade.answers.map((a) => {
          const node = props.nodesById.get(a.nodeId);
          const lines = props.answers.find((x) => x.nodeId === a.nodeId)?.lines ?? [];
          return (
            <div className="grade-row" key={a.nodeId}>
              <p><strong>{node?.text}</strong></p>
              {node?.gloss && <p className="fine">{node.gloss}</p>}
              {lines.length === 0 ? (
                <p className="chat-line empty-answer">(no reply — scored 0)</p>
              ) : (
                <p className="chat-line">{lines.map((l) => l.text).join(' ')}</p>
              )}
              {a.points.map((p) => (
                <p key={p.index}>
                  <VerdictChip verdict={p.result === 'none' ? 'missed' : p.result === 'hit' ? 'hit' : 'partial-point'} />{' '}
                  {node?.expectedPoints[p.index]?.text ?? ''}
                  {p.quote && <blockquote>“{p.quote}”</blockquote>}
                </p>
              ))}
              {node && node.expectedPoints.length > 0 && (
                <p className="fine">
                  A strong reply covers: {node.expectedPoints.map((p) => p.text).join(' ')}
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section aria-label="Peeks">
        <h2>Peeks</h2>
        <p>
          {props.peeks.length} peek{props.peeks.length === 1 ? '' : 's'}
          {props.peeks.length > 0 && (
            <> on {[...new Set(props.peeks.map((p) => notesById.get(p.noteId)?.label ?? p.noteId))].join(', ')}</>
          )}
          . {score.peekPenalty > 0 ? `−${formatPoints(score.peekPenalty)} points` : 'no penalty'}.
        </p>
      </section>

      <div className="sticky-action">
        <button type="button" className="primary" onClick={props.onRetry}>Coach again</button>
        <div className="row">
          <button type="button" className="secondary" onClick={props.onMoreSessions}>More sessions</button>
          <button type="button" className="secondary" onClick={props.onExit}>Home</button>
        </div>
      </div>
    </>
  );
}
