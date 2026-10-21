'use client';

// The sequenced practice run of a learner (ADR 0063, IF-2 1.3.0): ONE challenge on stage at a time, a countdown that starts when the learner presses Begin, the points of
// the account, and a way to start a new run once the run is finished. Challenges ahead are never listed: the rail only counts them. Presentational: AttemptBoard loads the
// data and owns the actions. Everything the server sends is rendered as text. The countdown is cosmetic: it is drawn from the server's clock (skew) and the server decides.
import { useEffect, useRef } from 'react';
import type { Attempt, CatalogueItem, ChallengeProgress, Hint, Instance, ProgressList, Score } from '../lib/api';
import { FINISHED_STATES, challengeLimitSeconds, challengePhase, challengeSecondsLeft, clock, runTotal, stageItem, urgency } from '../lib/attempt-logic';

const INSTANCE_READY = ['ready', 'active', 'idle'];
const HINT_NAMES = ['A nudge', 'A direction', 'Nearly the answer'];

export type StageProps = {
  attempt: Attempt;
  instance: Instance | null;
  list: ProgressList;
  catalog: CatalogueItem[];
  hints: Record<string, Hint[]>;
  hintError: { key: string; level: number; text: string } | null;
  flagNote: { key: string; ok: boolean; text: string } | null;
  score: Score | null;
  picked: string | null;
  now: number;
  skew: number;
  onPick: (key: string | null) => void;
  onStartRun: () => void;
  onBegin: (key: string) => void;
  onHint: (key: string, level: number) => void;
  onFlag: (key: string, input: HTMLInputElement) => void;
  onFinish: () => void;
  onOpen: () => void;
  onLoadHints: (key: string) => void;
  /** Called once when the countdown of the challenge on stage reaches zero: the server decides what happened, so the board reads it again. */
  onTimeUp: () => void;
};

export function SequencedStage(p: StageProps) {
  const { attempt, instance, list, catalog } = p;
  const keys = catalog.length ? catalog.map((c) => c.challenge_key) : list.items.map((i) => i.challenge_key);
  const titleOf = (i: ChallengeProgress) => i.title ?? catalog.find((c) => c.challenge_key === i.challenge_key)?.title ?? i.challenge_key;
  const points = Object.fromEntries((p.score?.per_challenge ?? []).map((c) => [c.challenge_key, c.points]));
  const item = stageItem(list, p.picked);
  const finished = FINISHED_STATES.includes(attempt.state);
  const instanceReady = !!instance && INSTANCE_READY.includes(instance.state) && instance.access === 'open';
  const instanceGone = !instance || ['destroyed', 'failed'].includes(instance.state);

  // the time-up call is made once per challenge that reaches zero while it is on stage
  const left = item ? challengeSecondsLeft(item, p.now, p.skew) : null;
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (item && left === 0 && firedFor.current !== item.challenge_key) {
      firedFor.current = item.challenge_key;
      p.onTimeUp();
    }
    if (item && left !== null && left > 0 && firedFor.current === item.challenge_key) firedFor.current = null;
  });

  const activeKey = item && challengePhase(item) === 'active' && item.hints_available && attempt.hints_enabled ? item.challenge_key : null;
  const hintsLoaded = activeKey ? p.hints[activeKey] !== undefined : true;
  useEffect(() => {
    if (activeKey && !hintsLoaded) p.onLoadHints(activeKey);
  }, [activeKey, hintsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="stage" data-testid="sequenced-stage" aria-label="Your practice run">
      <ol className="rail" aria-label="Your progress through the challenges">
        {keys.map((key, n) => {
          const it = list.items.find((i) => i.challenge_key === key);
          const ph = it ? challengePhase(it) : 'future';
          const cls = it && item && item.challenge_key === key ? 'now' : ph === 'solved' ? 'done' : ph === 'expired' ? 'lost' : '';
          return (
            <li key={key} className={cls}>
              <button
                type="button"
                className={it ? 'dot' : 'dot locked'}
                aria-disabled={it ? undefined : true}
                title={it ? `Challenge ${n + 1}: ${titleOf(it)}` : `Challenge ${n + 1} is locked. Capture challenge ${n}, or let its time run out, to open it.`}
                aria-current={it && item && item.challenge_key === key ? 'step' : undefined}
                aria-label={`Challenge ${n + 1}${it ? `: ${titleOf(it)}` : ''}, ${ph === 'future' ? 'locked' : ph}`}
                onClick={() => { if (it) p.onPick(key); }}
              >
                {ph === 'solved' ? '✓' : n + 1}
              </button>
            </li>
          );
        })}
      </ol>

      <article className="mission" data-testid="mission">
        {finished ? (
          <FinishedPanel {...p} titleOf={titleOf} points={points} />
        ) : attempt.state === 'ready' || (!instanceGone && !instanceReady) ? (
          <Preparing />
        ) : instanceGone ? (
          <div data-testid="no-shop">
            <h2 className="m-title">Your shop is not running</h2>
            <p className="lede">Your run is still open. Build a new shop to carry on with the current challenge.</p>
            <p><button type="button" onClick={p.onStartRun}>Build a new shop</button></p>
          </div>
        ) : item ? (
          <Stage {...p} item={item} titleOf={titleOf} points={points} left={left} total={runTotal(list, catalog.length)} position={keys.indexOf(item.challenge_key) + 1} instanceReady={instanceReady} />
        ) : (
          <Preparing />
        )}
      </article>
    </section>
  );
}

function Preparing() {
  return (
    <div data-testid="preparing" role="status">
      <h2 className="m-title">Building your private shop</h2>
      <p className="lede">This takes a few seconds. Your challenge opens as soon as it is ready; no time is counted yet.</p>
    </div>
  );
}

function FinishedPanel(p: StageProps & { titleOf: (i: ChallengeProgress) => string; points: Record<string, number> }) {
  const expired = p.attempt.state === 'expired';
  const withUp = p.list.items.filter((i) => i.write_up);
  return (
    <div data-testid="run-finished">
      <h2 className="m-title">{expired ? 'This run ran out of time' : 'This run is finished'}</h2>
      <p className="lede">
        You scored {p.score?.score ?? 0} of 1000 in this run. Your account keeps your best result for each challenge, so a new run can only add points.
      </p>
      <ul className="plain">
        {p.list.items.map((i) => (
          <li key={i.challenge_key}>
            <strong>{i.challenge_key}</strong> {p.titleOf(i)}: {challengePhase(i) === 'solved' ? 'captured' : challengePhase(i) === 'expired' ? 'time ran out' : 'not captured'}, {p.points[i.challenge_key] ?? 0} pts
          </li>
        ))}
      </ul>
      {withUp.map((i) => (
        <div key={i.challenge_key} className="writeup" data-testid="writeup">
          <strong>{i.challenge_key}. What was wrong.</strong> {i.write_up!.vulnerable}{'\n'}<strong>How to fix it.</strong> {i.write_up!.fix}
        </div>
      ))}
      <p><button type="button" onClick={p.onStartRun}>Start a new run</button></p>
    </div>
  );
}

function Stage(p: StageProps & { item: ChallengeProgress; titleOf: (i: ChallengeProgress) => string; points: Record<string, number>; left: number | null; total: number; position: number; instanceReady: boolean }) {
  const { item, attempt, left } = p;
  const phase = challengePhase(item);
  const minutes = Math.round(challengeLimitSeconds(item) / 60);
  const tag = urgency(left);
  const hints = p.hints[item.challenge_key] ?? [];
  const note = p.flagNote && p.flagNote.key === item.challenge_key ? p.flagNote : null;
  return (
    <div data-testid="stage-item" data-challenge={item.challenge_key} data-phase={phase}>
      <p className="kicker">
        Challenge {p.position || '?'} of {p.total || '?'}
        {item.tier && <span className={`tag tier-${item.tier}`}>{item.tier}</span>}
      </p>
      <h2 className="m-title">{p.titleOf(item)}</h2>
      {(phase === 'active' || phase === 'ready') && (
        <p className={`timer ${tag}`} data-testid="challenge-timer" role="timer" aria-label={phase === 'active' ? 'Time left for this challenge' : 'Time this challenge will have'}>
          <span className="digits">{clock(phase === 'active' ? left ?? 0 : challengeLimitSeconds(item))}</span>{' '}
          <span className="muted">{phase === 'active' ? 'left' : 'to play once you begin'}</span>
          {phase === 'active' && <progress max={challengeLimitSeconds(item)} value={left ?? 0} aria-hidden="true" />}
        </p>
      )}
      {phase === 'ready' && (
        <>
          {item.brief && <p className="lede">{item.brief}</p>}
          <p className="muted">You will have {minutes} minutes once you begin. The countdown stops when you capture the flag. Read first if you like; nothing is counted yet.</p>
          <p><button type="button" data-testid="begin" onClick={() => p.onBegin(item.challenge_key)}>Begin challenge ({minutes} min)</button></p>
        </>
      )}
      {phase === 'active' && (
        <>
          {item.brief && <p className="lede">{item.brief}</p>}
          {item.start && <p className="box"><strong>How to begin.</strong> {item.start}</p>}
          <p><button type="button" className="ghost" disabled={!p.instanceReady} onClick={p.onOpen}>Open the shop in a new tab</button></p>
          {item.hints_available && attempt.hints_enabled && (
            <div className="hints" data-testid="hints">
              {[1, 2, 3].map((level) => {
                const h = hints.find((x) => x.level === level);
                const next = level === item.hints_used + 1;
                const err = p.hintError && p.hintError.key === item.challenge_key && p.hintError.level === level ? p.hintError.text : null;
                return (
                  <div key={level} className="hint" data-level={level}>
                    <strong>Hint {level}: {HINT_NAMES[level - 1]}.</strong>{' '}
                    {h?.unlocked && h.text ? <span>{h.text}</span> : (
                      <button type="button" className="ghost" disabled={!next} onClick={() => p.onHint(item.challenge_key, level)}>{next ? 'Reveal' : 'Locked'}</button>
                    )}
                    {err && <span className="bad" role="alert"> {err}</span>}
                  </div>
                );
              })}
            </div>
          )}
          <form className="row" onSubmit={(ev) => { ev.preventDefault(); p.onFlag(item.challenge_key, ev.currentTarget.elements.namedItem('flag') as HTMLInputElement); }}>
            <input name="flag" className="flag-input" placeholder="VM{...}" maxLength={200} autoComplete="off" spellCheck={false} aria-label={`Flag for ${p.titleOf(item)}`} />
            <button type="submit">Check flag</button>
          </form>
          {note && <p className={note.ok ? 'ok' : 'bad'} role="status" data-testid="flag-note">{note.text}</p>}
        </>
      )}
      {(phase === 'solved' || phase === 'expired') && (
        <>
          <p className={phase === 'solved' ? 'ok' : 'bad'} data-testid="challenge-result">
            {phase === 'solved' ? (item.held ? 'Captured, waiting for a review.' : 'Flag captured.') : 'The time for this challenge is over.'} {p.points[item.challenge_key] ?? 0} pts
          </p>
          {item.write_up && (
            <div className="writeup" data-testid="writeup">
              <strong>What was wrong.</strong> {item.write_up.vulnerable}{'\n'}<strong>How to fix it.</strong> {item.write_up.fix}
            </div>
          )}
          <p className="row">
            {p.list.current_key && p.list.current_key !== item.challenge_key
              ? <button type="button" data-testid="next" onClick={() => p.onPick(null)}>{phase === 'solved' ? 'Next challenge' : 'Go to the current challenge'}</button>
              : !p.list.current_key && attempt.state === 'running'
                ? <button type="button" data-testid="finish-run" onClick={p.onFinish}>Finish this run</button>
                : null}
          </p>
        </>
      )}
    </div>
  );
}
