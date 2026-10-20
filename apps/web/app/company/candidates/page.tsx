'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, say, when, type Attempt, type CompanyInvite, type Progress } from '../../../lib/api';
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
      <div className="card table-wrap">
        {rows.length === 0 ? <p className="muted">No invitations yet.</p> : (
          <table data-testid="monitor">
            <thead><tr><th>Candidate</th><th>Invite</th><th>Attempt</th><th>Time left</th><th>Progress</th><th /></tr></thead>
            <tbody>
              {rows.map(({ invite, attempt, progress }) => {
                const left = attempt?.state === 'running' && attempt.deadline_at ? Math.max(0, Math.round((Date.parse(attempt.deadline_at) - now) / 1000)) : null;
                const captured = progress.filter((p) => p.solved).length;
                return (
                  <tr key={invite.invite_id} data-invite={invite.invite_id}>
                    <td>
                      {invite.email}<span className="tag">sent {when(invite.sent_at ?? invite.created_at)}</span>
                      {invite.generation > 1 && <span className="tag">re-invite, attempt {invite.generation}</span>}
                      {invite.superseded_by && <span className="tag">replaced by a re-invite</span>}
                    </td>
                    <td><span className="pill">{invite.state}</span></td>
                    <td>{attempt ? <span className={`pill ${attempt.state === 'running' ? 'ok' : ''}`}>{attempt.state}</span> : '-'}</td>
                    <td>{left !== null ? `${Math.floor(left / 3600)}h ${String(Math.floor(left / 60) % 60).padStart(2, '0')}m ${String(left % 60).padStart(2, '0')}s` : '-'}</td>
                    <td>
                      {progress.length > 0 ? (
                        <>
                          <strong>{captured}</strong> captured
                          <span className="tag">{progress.filter((p) => p.best_milestone !== 'none').map((p) => `${p.challenge_key} ${MILESTONE[p.best_milestone] ?? p.best_milestone}`).join(' · ') || 'no milestone yet'}</span>
                        </>
                      ) : '-'}
                    </td>
                    <td>{attempt && ['running', 'submitted', 'reported', 'expired'].includes(attempt.state) && <Link href={`/company/candidates/${invite.attempt_id}`}>Report</Link>}</td>
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
