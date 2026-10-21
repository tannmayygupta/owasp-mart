'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, inviteActions, say, timeWarning, when, type Attempt, type CompanyInvite, type InviteAction, type Progress } from '../../../lib/api';
import { useLive } from '../../../lib/live';
import { useRequireUser } from '../../../lib/session';

// The recruiter's live monitor (story P-27, FR-DSH-03): each invited candidate's state (invited, consented, running, submitted), the milestones reached and the
// captures, and the countdown of the time limit, updated from the company's live stream without a refresh (P-22, P-23: the stream only carries the company's
// events). The invites are the company's own (IF-1); the attempt and its progress come from the lab's reviewer routes, which check the company.
type Row = { invite: CompanyInvite; attempt: Attempt | null; progress: Progress[] };
const MILESTONE: Record<string, string> = { none: '-', M1: 'found', M2: 'exploited', M3: 'captured' };

export default function CandidatesPage() {
  const user = useRequireUser();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  // One invite action (resend, cancel, revoke, re-invite; IF-1 actOnInvite). The API decides what is allowed; a refusal is shown, never hidden.
  async function doAction(invite: CompanyInvite, action: InviteAction): Promise<string | null> {
    try {
      await api('POST', `/api/v1/company/invites/${invite.invite_id}/actions`, { action });
      return null;
    } catch (e) {
      return say(e);
    }
  }
  async function act(invite: CompanyInvite, action: InviteAction) {
    const sure = action === 'revoke' || action === 'reinvite' || action === 'cancel';
    if (sure && !window.confirm(action === 'reinvite'
      ? `Give ${invite.email} a new attempt? The old attempt is cancelled and stays in the record, and the invite counts against today's limit.`
      : `${action === 'revoke' ? 'Revoke' : 'Cancel'} the invitation of ${invite.email}? The link stops working.`)) return;
    const problem = await doAction(invite, action);
    setNotice('');
    setError(problem ?? '');
    if (!problem) setNotice(`${invite.email}: ${action === 'resend' ? 'a new link was sent' : action === 'reinvite' ? 'a new attempt was invited' : action === 'revoke' ? 'revoked' : 'cancelled'}.`);
    await load();
  }
  // Cancel an attempt that has not ended (FR-SES-07, IF-2 cancelAttempt): the instance is destroyed at once and nothing scores any more.
  async function cancelAttempt(invite: CompanyInvite) {
    if (!window.confirm(`Cancel the attempt of ${invite.email}? Their instance is destroyed now and nothing scores any more. This cannot be undone; to give them another go, use a re-invite.`)) return;
    try {
      await api('POST', `/api/v1/attempts/${invite.attempt_id}/cancel`);
      setError('');
      setNotice(`${invite.email}: the attempt was cancelled.`);
    } catch (e) {
      setNotice('');
      setError(say(e));
    }
    await load();
  }
  // The bulk form of the same actions: the chosen invites one after the other, then one summary (no bulk route: each call is checked by the API on its own).
  async function bulk(action: 'resend' | 'revoke') {
    const chosen = rows.map((r) => r.invite).filter((i) => picked.includes(i.invite_id));
    if (action === 'revoke' && !window.confirm(`Revoke ${chosen.length} invitation(s)? The links stop working.`)) return;
    let done = 0;
    const failed: string[] = [];
    for (const invite of chosen) {
      if (!inviteActions(invite).includes(action)) { failed.push(`${invite.email}: not possible in state ${invite.state}`); continue; }
      const problem = await doAction(invite, action);
      if (problem) failed.push(`${invite.email}: ${problem}`); else done += 1;
    }
    setPicked([]);
    setError(failed.length ? failed.join(' | ') : '');
    setNotice(`${action === 'resend' ? 'Resent' : 'Revoked'}: ${done} of ${chosen.length}.`);
    await load();
  }

  const load = useCallback(async () => {
    try {
      const invites = (await api<{ items: CompanyInvite[] }>('GET', '/api/v1/company/invites')).items;
      const out = await Promise.all(invites.map(async (invite): Promise<Row> => {
        // a live invite's attempt, and the attempt of an invite a re-invite replaced: its results stay visible to the recruiter (FR-ASM-05, H-141)
        const hasAttempt = !!invite.attempt_id && (['consented', 'started'].includes(invite.state) || !!invite.superseded_by);
        if (!hasAttempt) return { invite, attempt: null, progress: [] };
        const attempt = await api<Attempt>('GET', `/api/v1/attempts/${invite.attempt_id}`).catch(() => null);
        const progress = attempt && attempt.state !== 'ready'
          ? (await api<{ items: Progress[] }>('GET', `/api/v1/attempts/${invite.attempt_id}/challenges`).catch(() => ({ items: [] as Progress[] }))).items
          : [];
        return { invite, attempt, progress };
      }));
      setRows(out);
      setError('');
    } catch (e) {
      setError(say(e));
    }
  }, []);

  useEffect(() => {
    if (user?.account_type === 'recruiter') void load();
  }, [user, load]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Live events reload the list; no fast polling here: the stream is not activity (H-143), and polling every few seconds would keep an idle recruiter signed in.
  // Polling runs only while the stream is down (lib/live.ts).
  useLive(() => void load());

  if (!user) return <p className="muted">Loading...</p>;
  if (user.account_type !== 'recruiter') return <p className="card">This page is for recruiters. <Link href="/dashboard">Back to your dashboard</Link></p>;

  return (
    <>
      <h1>Candidates</h1>
      <p className="muted">Updates live. <Link href="/company">Templates and invitations</Link></p>
      {error && <p className="banner bad" role="alert">{error}</p>}
      {notice && <p className="banner ok" role="status">{notice}</p>}
      {picked.length > 0 && (
        <p className="row" data-testid="bulk-bar">
          <span>{picked.length} chosen</span>
          <button type="button" className="ghost" onClick={() => void bulk('resend')}>Resend the chosen</button>
          <button type="button" className="danger" onClick={() => void bulk('revoke')}>Revoke the chosen</button>
        </p>
      )}
      <div className="card table-wrap" tabIndex={0} role="region" aria-label="Invitations and candidates">
        {rows.length === 0 ? <p className="muted">No invitations yet.</p> : (
          <table data-testid="monitor">
            <thead><tr><th><span className="sr-only">Choose</span></th><th>Candidate</th><th>Invite</th><th>Attempt</th><th>Time left</th><th>Progress</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map(({ invite, attempt, progress }) => {
                const left = attempt?.state === 'running' && attempt.deadline_at ? Math.max(0, Math.round((Date.parse(attempt.deadline_at) - now) / 1000)) : null;
                const captured = progress.filter((p) => p.solved).length;
                return (
                  <tr key={invite.invite_id} data-invite={invite.invite_id}>
                    <td>
                      {['resend', 'revoke'].some((a) => inviteActions(invite).includes(a as InviteAction)) && (
                        <input type="checkbox" aria-label={`Choose ${invite.email}`} checked={picked.includes(invite.invite_id)}
                          onChange={(ev) => setPicked(ev.target.checked ? [...picked, invite.invite_id] : picked.filter((p) => p !== invite.invite_id))} />
                      )}
                    </td>
                    <td>
                      {invite.email}<span className="tag">sent {when(invite.sent_at ?? invite.created_at)}</span>
                      {invite.generation > 1 && <span className="tag">re-invite, attempt {invite.generation}</span>}
                      {invite.superseded_by && <span className="tag">replaced by a re-invite</span>}
                    </td>
                    <td><span className="pill">{invite.state}</span></td>
                    <td>{attempt ? <span className={`pill ${attempt.state === 'running' ? 'ok' : ''}`}>{attempt.state}</span> : '-'}</td>
                    <td>
                      {left !== null ? `${Math.floor(left / 3600)}h ${String(Math.floor(left / 60) % 60).padStart(2, '0')}m ${String(left % 60).padStart(2, '0')}s` : '-'}
                      {timeWarning(left) !== null && <> <span className="pill bad" data-testid="time-alert">{timeWarning(left)} min left</span></>}
                    </td>
                    <td>
                      {progress.length > 0 ? (
                        <>
                          <strong>{captured}</strong> captured
                          <span className="tag">{progress.filter((p) => p.best_milestone !== 'none').map((p) => `${p.challenge_key} ${MILESTONE[p.best_milestone] ?? p.best_milestone}`).join(' · ') || 'no milestone yet'}</span>
                        </>
                      ) : '-'}
                    </td>
                    <td className="row">
                      {attempt && ['running', 'submitted', 'reported', 'expired'].includes(attempt.state) && <Link href={`/company/candidates/${invite.attempt_id}`} aria-label={`Report of ${invite.email}`}>Report</Link>}
                      {attempt && ['ready', 'running'].includes(attempt.state) && (
                        <button type="button" className="danger" aria-label={`Cancel the attempt of ${invite.email}`} onClick={() => void cancelAttempt(invite)}>Cancel attempt</button>
                      )}
                      {inviteActions(invite).map((a) => (
                        <button key={a} type="button" className={a === 'revoke' || a === 'cancel' ? 'danger' : 'ghost'} aria-label={`${a === 'reinvite' ? 'Re-invite' : a[0].toUpperCase() + a.slice(1)} ${invite.email}`}
                          onClick={() => void act(invite, a)}>{a === 'reinvite' ? 'Re-invite' : a[0].toUpperCase() + a.slice(1)}</button>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
