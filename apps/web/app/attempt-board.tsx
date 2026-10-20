'use client';

// One attempt on a dashboard (story P-26): its state and clock, the instance controls, and per challenge the stars, both OWASP tags, the difficulty, the progress,
// the hints, the flag box and, after a solve, the write-up (FR-DSH-01, FR-HNT-01, FR-HNT-02). Shared by the learner and the candidate pages; the differences
// are props: whether hints cost points (a candidate confirms the cost first, FR-HNT-02) and whether results may be shown (OI-15, `results_visibility`).
// Everything the server sends is rendered as text. A flag is sent and the box is cleared; it is never kept in the page.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, say, type Attempt, type CatalogueItem, type Hint, type Instance, type Progress, type Score, type Writeup } from '../lib/api';
import { useLive } from '../lib/live';

const LIVE_INSTANCE = ['ready', 'active', 'idle'];
const SETTLED_INSTANCE = ['ready', 'active', 'idle', 'destroyed', 'failed'];
const MILESTONE_LABEL: Record<string, string> = { none: 'not yet', M1: 'found it', M2: 'exploited', M3: 'captured' };

export function Stars({ difficulty }: { difficulty: number }) {
  const n = Math.max(1, Math.min(5, difficulty));
  return <span className="stars" aria-label={`difficulty ${n} of 5`} title={`difficulty ${n} of 5`}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span>;
}

type Props = {
  attemptId: string;
  catalog: CatalogueItem[];
  /** Results (score, points, report) may be shown for this attempt in its current state. */
  resultsAllowed: (attempt: Attempt) => boolean;
  /** Called after a change that the surrounding page lists (state, withdrawal). */
  onChanged?: () => void;
};

export function AttemptBoard({ attemptId, catalog, resultsAllowed, onChanged }: Props) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [score, setScore] = useState<Score | null>(null);
  const [hints, setHints] = useState<Record<string, Hint[]>>({});
  const [writeups, setWriteups] = useState<Record<string, Writeup>>({});
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    try {
      const a = await api<Attempt>('GET', `/api/v1/attempts/${attemptId}`);
      setAttempt(a);
      setInstance(a.instance_id ? await api<Instance>('GET', `/api/v1/instances/${a.instance_id}`).catch(() => null) : null);
      if (['running', 'submitted', 'reported', 'expired'].includes(a.state)) {
        setProgress((await api<{ items: Progress[] }>('GET', `/api/v1/attempts/${attemptId}/challenges`)).items);
        setScore(resultsAllowed(a) ? await api<Score>('GET', `/api/v1/attempts/${attemptId}/score`).catch(() => null) : null);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.location.replace('/login');
      else setMessage({ text: say(e), kind: 'bad' });
    }
  }, [attemptId, resultsAllowed]);

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
    try {
      await fn();
      if (ok) setMessage({ text: ok, kind: 'ok' });
    } catch (e) {
      setMessage({ text: say(e), kind: 'bad' });
    }
    await reload();
    onChanged?.();
  }

  if (!attempt) return <p className="muted">Loading the attempt...</p>;
  const learner = attempt.mode === 'learner';
  const running = attempt.state === 'running';
  const instanceLive = !!instance && LIVE_INSTANCE.includes(instance.state) && instance.access === 'open' && running;
  const canRequest = learner && ['ready', 'running'].includes(attempt.state) && (!instance || ['destroyed', 'failed'].includes(instance.state));
  const info = Object.fromEntries(catalog.map((c) => [c.challenge_key, c]));
  const points = Object.fromEntries((score?.per_challenge ?? []).map((c) => [c.challenge_key, c.points]));
  const left = attempt.deadline_at && running ? Math.max(0, Math.round((Date.parse(attempt.deadline_at) - now) / 1000)) : null;

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
      setMessage({ text: say(e), kind: 'bad' });
    }
  }

  async function unlock(key: string, hint: Hint) {
    if (hint.cost_pct > 0 && !window.confirm(`This hint costs ${hint.cost_pct}% of this challenge's points. Unlock it?`)) return;
    await act(async () => {
      await api('POST', `/api/v1/attempts/${attemptId}/challenges/${key}/hints/${hint.level}/unlock`);
      await loadHints(key);
    });
  }

  async function sendFlag(key: string, input: HTMLInputElement) {
    const flag = input.value.trim();
    input.value = '';
    if (!flag) return;
    await act(async () => {
      const r = await api<{ result: string; credit: string }>('POST', `/api/v1/attempts/${attemptId}/flags`, { challenge_key: key, flag });
      if (r.result !== 'correct') setMessage({ text: `${key}: that is not the flag for this challenge.`, kind: 'bad' });
      else setMessage({ text: r.credit === 'held' ? `${key}: correct, held for a review.` : `${key}: correct, captured.`, kind: 'ok' });
    });
  }

  return (
    <div className="stack" data-testid="attempt-board">
      {message && <p className={`banner ${message.kind}`} role={message.kind === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
      <dl className="facts">
        <dt>Attempt</dt><dd><span className="pill" data-testid="attempt-state">{attempt.state}</span></dd>
        <dt>Instance</dt><dd><span className={`pill ${instanceLive ? 'ok' : starting ? 'warn' : ''}`} data-testid="instance-state">{instance ? instance.state : 'none'}</span></dd>
        {left !== null && <><dt>Time left</dt><dd>{Math.floor(left / 3600)}h {String(Math.floor(left / 60) % 60).padStart(2, '0')}m {String(left % 60).padStart(2, '0')}s</dd></>}
        {score && <><dt>Score</dt><dd data-testid="score">{score.score} of 1000</dd></>}
      </dl>

      <div className="row">
        {canRequest && <button type="button" onClick={() => act(() => api('POST', '/api/v1/instances', { kind: 'learner' }), 'Starting your instance. This takes a few seconds.')}>Start an instance</button>}
        {!learner && attempt.state === 'ready' && (
          <button type="button" onClick={() => { if (window.confirm('The clock starts now and cannot be paused. Start?')) void act(() => api('POST', `/api/v1/attempts/${attemptId}/start`), 'Started. Your instance is being prepared.'); }}>
            Start the assessment
          </button>
        )}
        {instance && running && <button type="button" disabled={!instanceLive} onClick={openInstance}>Open the shop</button>}
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
        {running && (
          <button type="button" className="ghost" onClick={() => { if (window.confirm('Submitting ends the attempt: the clock stops and the instance is frozen. Continue?')) void act(() => api('POST', `/api/v1/attempts/${attemptId}/submit`, { confirm: true }), 'Submitted.'); }}>
            Submit
          </button>
        )}
        {!learner && ['ready', 'running', 'submitted'].includes(attempt.state) && (
          <button type="button" className="danger" onClick={() => { if (window.confirm('Withdraw from this assessment? Your attempt stops and its data is deleted after 7 days unless you undo.')) void act(() => api('POST', `/api/v1/attempts/${attemptId}/withdraw`, { confirm: true }), 'Withdrawn. You can undo this for 7 days.'); }}>
            Withdraw
          </button>
        )}
        {!learner && attempt.state === 'withdrawn' && (
          <button type="button" onClick={() => act(() => api('POST', `/api/v1/attempts/${attemptId}/withdraw/undo`), 'Your withdrawal is undone.')}>Undo the withdrawal</button>
        )}
      </div>

      {progress.length > 0 && (
        <div className="table-wrap">
          <table data-testid="challenges">
            <thead>
              <tr><th>Challenge</th><th>Difficulty</th><th>Progress</th><th>Hints</th>{score && <th>Points</th>}<th>Flag</th></tr>
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
                      {p.solved && (writeups[p.challenge_key] ? (
                        <div className="writeup" data-testid="writeup">
                          <strong>Why it was vulnerable.</strong> {writeups[p.challenge_key].vulnerable}{'\n'}<strong>The fix.</strong> {writeups[p.challenge_key].fix}
                        </div>
                      ) : (
                        <button type="button" className="ghost" onClick={() => act(async () => {
                          const w = await api<Writeup>('GET', `/api/v1/attempts/${attemptId}/challenges/${p.challenge_key}/writeup`);
                          setWriteups((all) => ({ ...all, [p.challenge_key]: w }));
                        })}>Read the write-up</button>
                      ))}
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
                                <button type="button" className="ghost" disabled={!running} onClick={() => unlock(p.challenge_key, h)}>
                                  Unlock {h.kind.replace('_', ' ')}{h.cost_pct > 0 ? ` (costs ${h.cost_pct}%)` : ''}
                                </button>
                              )}
                            </div>
                          ))}
                        </>
                      ) : <span className="muted">-</span>}
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
      {!resultsAllowed(attempt) && !learner && ['submitted', 'reported'].includes(attempt.state) && (
        <p className="muted" data-testid="results-later">The company shows you the results when it releases them.</p>
      )}
    </div>
  );
}
