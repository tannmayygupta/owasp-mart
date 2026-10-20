'use client';

// One attempt on a dashboard (story P-26, reworked in work package E): its state and clock, the instance controls, and per challenge the progress, the hints, the flag box
// and, after a solve, the write-up. Shared by the learner and the candidate pages; the differences are props: which `mode` this screen is for (a candidate assessment is
// NEVER drawn as practice and a practice run never as an assessment), whether hints cost points (a candidate confirms the cost first, FR-HNT-02) and whether results may
// be shown (OI-15, `results_visibility`).
// A learner's run on the deployed lab is SEQUENCED (ADR 0063): one challenge at a time with its own countdown, drawn by SequencedStage. A company assessment keeps the
// board of all challenges. The countdowns are drawn from the server's clock (`server_time` skew); the server decides.
// Everything the server sends is rendered as text. A flag is sent and the box is cleared; it is never kept in the page.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, say, timeWarning, type AccountProgress, type Attempt, type CatalogueItem, type Hint, type Instance, type ProgressList, type Score } from '../lib/api';
import { FINISHED_STATES, clock, isSequenced, modeMatches, secondsLeft, skewMs, type Mode } from '../lib/attempt-logic';
import { useLive } from '../lib/live';
import { SequencedStage } from './sequenced-stage';

const LIVE_INSTANCE = ['ready', 'active', 'idle'];
const SETTLED_INSTANCE = ['ready', 'active', 'idle', 'destroyed', 'failed'];
const MILESTONE_LABEL: Record<string, string> = { none: 'not yet', M1: 'found it', M2: 'exploited', M3: 'captured' };
const ENDED_STATES = ['submitted', 'reported', 'expired'];

export function Stars({ difficulty }: { difficulty: number }) {
  const n = Math.max(1, Math.min(5, difficulty));
  return <span className="stars" aria-label={`difficulty ${n} of 5`} title={`difficulty ${n} of 5`}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span>;
}

type Props = {
  attemptId: string;
  catalog: CatalogueItem[];
  /** The mode this screen is made for. An attempt of the other mode is refused with a notice and a link, never drawn. */
  expectedMode: Mode;
  /** Results (score, points, report) may be shown for this attempt in its current state (a learner's own practice results always may). */
  resultsAllowed: (attempt: Attempt) => boolean;
  /** Called after a change that the surrounding page lists (state, withdrawal). */
  onChanged?: () => void;
};

export function AttemptBoard({ attemptId, catalog, expectedMode, resultsAllowed, onChanged }: Props) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [list, setList] = useState<ProgressList | null>(null);
  const [score, setScore] = useState<Score | null>(null);
  const [account, setAccount] = useState<AccountProgress | null>(null);
  const [hints, setHints] = useState<Record<string, Hint[]>>({});
  const [hintError, setHintError] = useState<{ key: string; level: number; text: string } | null>(null);
  const [flagNote, setFlagNote] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [skew, setSkew] = useState(0);
  const [busy, setBusy] = useState(false);
  const lastList = useRef<ProgressList | null>(null);

  const reload = useCallback(async () => {
    try {
      const a = await api<Attempt>('GET', `/api/v1/attempts/${attemptId}`);
      setAttempt(a);
      if (!modeMatches(a, expectedMode)) {
        // the wrong screen for this attempt: nothing of it is loaded or drawn
        setInstance(null);
        setList(null);
        setScore(null);
        return;
      }
      let sk = skewMs(a.server_time, Date.now());
      setInstance(a.instance_id ? await api<Instance>('GET', `/api/v1/instances/${a.instance_id}`).catch(() => null) : null);
      if (['running', 'submitted', 'reported', 'expired'].includes(a.state)) {
        const l = await api<ProgressList>('GET', `/api/v1/attempts/${attemptId}/challenges`);
        // a challenge that was being played and ended while the page was open (its time ran out) stays on stage, so its result and write-up are seen before the next one
        const before = lastList.current?.current_key;
        if (before && lastList.current?.items.find((i) => i.challenge_key === before)?.state === 'active' && l.items.find((i) => i.challenge_key === before)?.state === 'expired') setPicked(before);
        lastList.current = l;
        setList(l);
        if (l.server_time) sk = skewMs(l.server_time, Date.now());
        setScore(resultsAllowed(a) ? await api<Score>('GET', `/api/v1/attempts/${attemptId}/score`).catch(() => null) : null);
      } else {
        setList(null);
        setScore(null);
      }
      setSkew(sk);
      if (a.mode === 'learner') setAccount(await api<AccountProgress>('GET', '/api/v1/me/progress').catch(() => null)); // a lab that is not sequenced has no account points
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.location.replace('/login');
      else setMessage({ text: say(e), kind: 'bad' });
    }
  }, [attemptId, expectedMode, resultsAllowed]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const starting = !!instance && !SETTLED_INSTANCE.includes(instance.state);
  useLive(() => void reload(), { busy: starting || attempt?.state === 'ready' });

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setMessage(null);
    setBusy(true);
    try {
      await fn();
      if (ok) setMessage({ text: ok, kind: 'ok' });
    } catch (e) {
      setMessage({ text: say(e), kind: 'bad' });
    } finally {
      setBusy(false);
    }
    await reload();
    onChanged?.();
  }

  if (!attempt) return <p className="muted" role="status">Loading the attempt...</p>;
  if (!modeMatches(attempt, expectedMode)) {
    return expectedMode === 'learner' ? (
      <p className="banner bad" role="alert" data-testid="wrong-mode">
        This is a company assessment, not practice. <Link href={`/assessment/${attemptId}`}>Open it on the assessment page.</Link>
      </p>
    ) : (
      <p className="banner bad" role="alert" data-testid="wrong-mode">
        This is a practice run, not an assessment. <Link href="/dashboard">Go to your practice lab.</Link>
      </p>
    );
  }

  const learner = attempt.mode === 'learner';
  const running = attempt.state === 'running';
  const sequenced = learner && isSequenced(list);
  const instanceLive = !!instance && LIVE_INSTANCE.includes(instance.state) && instance.access === 'open' && running;
  const canRequest = learner && !sequenced && ['ready', 'running'].includes(attempt.state) && (!instance || ['destroyed', 'failed'].includes(instance.state));
  const info = Object.fromEntries(catalog.map((c) => [c.challenge_key, c]));
  const points = Object.fromEntries((score?.per_challenge ?? []).map((c) => [c.challenge_key, c.points]));
  const left = running ? secondsLeft(attempt.deadline_at, now, skew) : null;
  const warning = sequenced ? null : timeWarning(left); // story 2.3: 15 and 5 minutes left (a sequenced run has a countdown per challenge instead)
  const progress = list?.items ?? [];

  async function openInstance() {
    const w = window.open('about:blank', '_blank'); // opened first so the browser allows it, filled when the ticket arrives
    if (w) w.opener = null; // the lab shop is vulnerable on purpose (XSS challenges): it must never reach this tab
    try {
      const t = await api<{ url: string }>('POST', `/api/v1/instances/${instance!.instance_id}/open`);
      if (w) w.location.href = t.url;
      else setMessage({ text: 'Allow pop-ups for this site, then press Open again.', kind: 'bad' });
    } catch (e) {
      w?.close();
      setMessage({ text: say(e), kind: 'bad' });
    }
  }

  async function loadHints(key: string) {
    try {
      const h = await api<{ items: Hint[] }>('GET', `/api/v1/attempts/${attemptId}/challenges/${key}/hints`);
      setHints((all) => ({ ...all, [key]: h.items }));
    } catch (e) {
      // hints may be off for this attempt: the sequenced stage then shows none; the table shows the reason
      setHints((all) => ({ ...all, [key]: [] }));
      if (!(e instanceof ApiError && (e.status === 404 || e.code === 'ATT-HINTS-DISABLED'))) setMessage({ text: say(e), kind: 'bad' });
    }
  }

  async function unlock(key: string, level: number, costPct: number) {
    if (costPct > 0 && !window.confirm(`This hint costs ${costPct}% of this challenge's points. Unlock it?`)) return;
    setHintError(null);
    try {
      await api('POST', `/api/v1/attempts/${attemptId}/challenges/${key}/hints/${level}/unlock`);
      await loadHints(key);
    } catch (e) {
      setHintError({ key, level, text: say(e) }); // shown on the hint's own row, where the learner is looking
    }
    await reload();
    onChanged?.();
  }

  async function sendFlag(key: string, input: HTMLInputElement) {
    const flag = input.value.trim();
    input.value = '';
    if (!flag) return;
    setFlagNote(null);
    await act(async () => {
      const r = await api<{ result: string; credit: string }>('POST', `/api/v1/attempts/${attemptId}/flags`, { challenge_key: key, flag });
      if (r.result !== 'correct') {
        setFlagNote({ key, ok: false, text: 'That is not the flag for this challenge.' });
        setMessage({ text: `${key}: that is not the flag for this challenge.`, kind: 'bad' });
      } else {
        const text = r.credit === 'held' ? 'Correct. A human reviews this capture before it counts.' : 'Correct. Flag captured.';
        setFlagNote({ key, ok: true, text });
        setMessage({ text: `${key}: ${r.credit === 'held' ? 'correct, held for a review.' : 'correct, captured.'}`, kind: 'ok' });
        setPicked(key); // stay on the captured challenge: the result and the way on come before the next one
      }
    });
  }

  const startRun = () => act(async () => {
    await api('POST', '/api/v1/instances', { kind: 'learner' });
    setPicked(null);
    setHints({});
    setFlagNote(null);
  }, 'Building your shop. This takes a few seconds.');
  const finishRun = () => { if (window.confirm('Finishing ends this run: every challenge that is not captured stays at what you earned. Continue?')) void act(() => api('POST', `/api/v1/attempts/${attemptId}/submit`, { confirm: true }), 'Run finished.'); };

  return (
    <div className="stack" data-testid="attempt-board" data-mode={attempt.mode}>
      {message && <p className={`banner ${message.kind}`} role={message.kind === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
      {warning !== null && (
        <p key={warning} className="banner bad" role="alert" data-testid="time-warning">
          {warning} minutes left. {learner ? 'The practice attempt ends at the deadline.' : 'Your assessment is submitted automatically at the deadline.'}
        </p>
      )}
      <dl className="facts">
        <dt>{learner ? 'Practice run' : 'Assessment'}</dt><dd><span className="pill" data-testid="attempt-state">{attempt.state}</span></dd>
        <dt>Instance</dt><dd><span className={`pill ${instanceLive ? 'ok' : starting ? 'warn' : ''}`} data-testid="instance-state">{instance ? instance.state : 'none'}</span></dd>
        {left !== null && <><dt>{sequenced ? 'Run ends in' : 'Time left'}</dt><dd data-testid="time-left">{clock(left)}</dd></>}
        {score && <><dt>{learner ? 'Run score' : 'Score'}</dt><dd data-testid="score">{score.score} of 1000</dd></>}
        {learner && account && <><dt>Account points</dt><dd data-testid="account-points">{account.total_points} of 1000 <span className="muted">(your best result for each challenge)</span></dd></>}
      </dl>

      <div className="row">
        {canRequest && <button type="button" disabled={busy} onClick={() => act(() => api('POST', '/api/v1/instances', { kind: 'learner' }), 'Starting your instance. This takes a few seconds.')}>Start an instance</button>}
        {!learner && attempt.state === 'ready' && !instance && (
          <button type="button" data-testid="start-assessment" disabled={busy} onClick={() => { if (window.confirm('Your instance is prepared first. The clock starts when it is ready and cannot be paused. Start?')) void act(() => api('POST', `/api/v1/attempts/${attemptId}/start`), 'Started. Your instance is being prepared; the clock starts when it is ready.'); }}>
            Start the assessment
          </button>
        )}
        {!learner && attempt.state === 'ready' && instance && <span className="muted" role="status" data-testid="preparing">Your instance is being prepared. The clock has not started.</span>}
        {instance && running && !sequenced && <button type="button" disabled={!instanceLive} onClick={openInstance}>Open the shop</button>}
        {instance && running && (
          <button type="button" className="ghost" disabled={!instanceLive} onClick={() => { if (window.confirm('Reset gives you a fresh shop and new flags. Flags you found before stop working. Continue?')) void act(() => api('POST', `/api/v1/instances/${instance.instance_id}/reset`, { confirm: true }), 'Resetting.'); }}>
            Reset
          </button>
        )}
        {learner && instance && running && !['stopping', 'destroyed'].includes(instance.state) && (
          <button type="button" className="ghost" onClick={() => { if (window.confirm('Stop frees the instance. You can start a new one later. Continue?')) void act(() => api('POST', `/api/v1/instances/${instance.instance_id}/stop`), 'Stopping.'); }}>
            Stop
          </button>
        )}
        {running && !sequenced && (
          <button type="button" className="ghost" data-testid="submit-attempt" onClick={() => { if (window.confirm('Submitting ends the attempt: the clock stops and the instance is frozen. Continue?')) void act(() => api('POST', `/api/v1/attempts/${attemptId}/submit`, { confirm: true }), 'Submitted.'); }}>
            Submit
          </button>
        )}
        {sequenced && running && <button type="button" className="ghost" onClick={finishRun}>Finish this run</button>}
        {!learner && ['ready', 'running', 'submitted'].includes(attempt.state) && (
          <button type="button" className="danger" data-testid="withdraw" onClick={() => { if (window.confirm('Withdraw from this assessment? Your attempt stops and its data is deleted after 7 days unless you undo.')) void act(() => api('POST', `/api/v1/attempts/${attemptId}/withdraw`, { confirm: true }), 'Withdrawn. You can undo this for 7 days.'); }}>
            Withdraw
          </button>
        )}
        {!learner && attempt.state === 'withdrawn' && attempt.delete_after && (
          <button type="button" data-testid="undo-withdraw" onClick={() => act(() => api('POST', `/api/v1/attempts/${attemptId}/withdraw/undo`), 'Your withdrawal is undone: nothing will be deleted.')}>Undo the withdrawal</button>
        )}
      </div>
      {!learner && attempt.state === 'withdrawn' && (
        <p className="muted" data-testid="withdrawn-note">
          {attempt.delete_after
            ? 'You withdrew from this assessment. Its data is deleted after the undo window ends unless you undo.'
            : 'You withdrew from this assessment and kept the record. It does not start again; ask the company for a new invitation if you want to take it.'}
        </p>
      )}
      {!learner && attempt.state === 'expired' && <p className="muted" data-testid="expired-note">Your time ran out and the assessment was closed.</p>}

      {sequenced && list && (
        <SequencedStage
          attempt={attempt}
          instance={instance}
          list={list}
          catalog={catalog}
          hints={hints}
          hintError={hintError}
          flagNote={flagNote}
          score={score}
          picked={picked}
          now={now}
          skew={skew}
          onPick={setPicked}
          onStartRun={() => void startRun()}
          onBegin={(key) => void act(async () => { await api('POST', `/api/v1/attempts/${attemptId}/challenges/${key}/begin`); setPicked(null); })}
          onHint={(key, level) => void unlock(key, level, 0)}
          onFlag={(key, input) => void sendFlag(key, input)}
          onFinish={finishRun}
          onOpen={() => void openInstance()}
          onLoadHints={(key) => void loadHints(key)}
          onTimeUp={() => void reload()}
        />
      )}
      {learner && !sequenced && attempt.state !== 'ready' && FINISHED_STATES.includes(attempt.state) && (
        <p><button type="button" disabled={busy} onClick={() => void startRun()}>Start a new run</button></p>
      )}

      {!sequenced && progress.length > 0 && (
        <div className="table-wrap">
          <table data-testid="challenges">
            <caption className="sr-only">Challenges of this {learner ? 'practice run' : 'assessment'}</caption>
            <thead>
              <tr><th scope="col">Challenge</th><th scope="col">Difficulty</th><th scope="col">Progress</th><th scope="col">Hints</th>{score && <th scope="col">Points</th>}<th scope="col">Flag</th></tr>
            </thead>
            <tbody>
              {progress.map((p) => {
                const c = info[p.challenge_key];
                const open = hints[p.challenge_key];
                return (
                  <tr key={p.challenge_key} data-challenge={p.challenge_key}>
                    <td>
                      <strong>{p.challenge_key}</strong> {c?.title ?? ''}
                      {c && <span className="tag">OWASP 2025 {c.owasp_2025}{c.owasp_2021 ? ` · 2021 ${c.owasp_2021}` : ''}</span>}
                      {p.brief && <span className="tag">{p.brief}</span>}
                      {p.start && !p.solved && running && <span className="tag">How to start: {p.start}</span>}
                      {p.write_up && learner && (
                        <div className="writeup" data-testid="writeup">
                          <strong>Why it was vulnerable.</strong> {p.write_up.vulnerable}{'\n'}<strong>The fix.</strong> {p.write_up.fix}
                        </div>
                      )}
                    </td>
                    <td>{c ? <><Stars difficulty={c.difficulty} /> <span className="tag">{c.tier}</span></> : '-'}</td>
                    <td><span className={`pill ${p.solved ? 'ok' : p.held ? 'warn' : ''}`}>{p.held ? 'held for review' : MILESTONE_LABEL[p.best_milestone] ?? p.best_milestone}</span></td>
                    <td>
                      {p.hints_available && attempt.hints_enabled ? (
                        <>
                          <span className="muted">{p.hints_used} of 3 used</span>{' '}
                          {!open && <button type="button" className="ghost" onClick={() => loadHints(p.challenge_key)}>Hints</button>}
                          {open && open.map((h) => (
                            <div key={h.level}>
                              {h.unlocked ? <p className="hint">{h.kind.replace('_', ' ')}: {h.text}</p> : (
                                <button type="button" className="ghost" disabled={!running} onClick={() => unlock(p.challenge_key, h.level, h.cost_pct)}>
                                  Unlock {h.kind.replace('_', ' ')}{h.cost_pct > 0 ? ` (costs ${h.cost_pct}%)` : ''}
                                </button>
                              )}
                              {hintError && hintError.key === p.challenge_key && hintError.level === h.level && <span className="bad" role="alert"> {hintError.text}</span>}
                            </div>
                          ))}
                        </>
                      ) : <span className="muted" data-testid="no-hints">{attempt.hints_enabled ? '-' : 'off'}</span>}
                    </td>
                    {score && <td>{points[p.challenge_key] ?? 0}</td>}
                    <td>
                      {running && !p.solved ? (
                        <form className="row" onSubmit={(ev) => { ev.preventDefault(); void sendFlag(p.challenge_key, ev.currentTarget.elements.namedItem('flag') as HTMLInputElement); }}>
                          <input name="flag" className="flag-input" placeholder="VM{...}" maxLength={200} autoComplete="off" spellCheck={false} aria-label={`Flag for ${p.challenge_key}`} />
                          <button type="submit">Check</button>
                        </form>
                      ) : <span className="muted">{p.solved ? 'done' : '-'}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!learner && ENDED_STATES.includes(attempt.state) && !resultsAllowed(attempt) && (
        <p className="muted" data-testid="results-later">Your submission was received. The company shows you the results when it releases them.</p>
      )}
    </div>
  );
}
