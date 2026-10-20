'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, say, when, type Attempt, type AttemptSummary, type CatalogueItem, type MyInvite } from '../../lib/api';
import { useRequireUser } from '../../lib/session';
import { AttemptBoard, Stars } from '../attempt-board';

const ACTIVE = ['ready', 'running', 'submitted', 'reported'];
const learnerResults = (_: Attempt) => true; // a learner's practice results are always their own to see

// The dashboard (FR-DSH-01, FR-DSH-04): a participant's practice lab and their invitations. Every list comes from the caller's own routes (`me`), so the page
// cannot show someone else's data. Recruiter and admin dashboards are stories P-27 and P-30.
export default function DashboardPage() {
  const user = useRequireUser();
  const [catalog, setCatalog] = useState<CatalogueItem[]>([]);
  const [attempts, setAttempts] = useState<AttemptSummary[] | null>(null);
  const [invites, setInvites] = useState<MyInvite[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      // the lab's routes (catalogue, attempts) and the platform's (invites) are loaded side by side: one being down must not hide the other
      const [c, a, i] = await Promise.all([
        api<{ items: CatalogueItem[] }>('GET', '/api/v1/challenges').catch(() => ({ items: [] as CatalogueItem[] })),
        api<{ items: AttemptSummary[] }>('GET', '/api/v1/me/attempts').catch((e) => {
          setError(say(e));
          return { items: [] as AttemptSummary[] };
        }),
        api<{ items: MyInvite[] }>('GET', '/api/v1/me/invites'),
      ]);
      setCatalog(c.items);
      setAttempts(a.items);
      setInvites(i.items);
    } catch (e) {
      setError(say(e));
    }
  }, []);

  useEffect(() => {
    if (user?.account_type === 'participant') void load();
  }, [user, load]);

  if (!user) return <p className="muted">Loading...</p>;
  if (user.account_type !== 'participant') {
    return (
      <div className="card">
        <h1>Dashboard</h1>
        {user.account_type === 'admin' && !user.mfa_enabled ? (
          <p>Set up your authenticator app on the <Link href="/account">account page</Link>: the admin area needs it.</p>
        ) : user.account_type === 'admin' ? (
          <p><Link href="/admin">Go to the administration</Link></p>
        ) : user.account_type === 'recruiter' ? (
          <p className="row"><Link href="/company/candidates">Your candidates</Link> <Link href="/company">Your company, templates and invitations</Link></p>
        ) : (
          <p className="muted">The {user.account_type} dashboard is not here yet.</p>
        )}
      </div>
    );
  }

  const practice = (attempts ?? []).filter((a) => a.mode === 'learner');
  const current = practice.find((a) => ACTIVE.includes(a.state)) ?? null;

  return (
    <>
      <h1>Hello, {user.display_name}</h1>
      {error && <p className="banner bad" role="alert">{error}</p>}

      {invites.length > 0 && (
        <section className="card" data-testid="invitations">
          <h2>Your assessments</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Company</th><th>Assessment</th><th>State</th><th>Time limit</th><th>Hints</th><th>Link expires</th><th /></tr></thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.invite_id}>
                    <td>{i.company_name}</td>
                    <td>{i.title}</td>
                    <td><span className="pill">{i.state}</span></td>
                    <td>{i.time_limit_min ? `${i.time_limit_min} min` : '-'}</td>
                    <td>{i.hints_mode === 'on' ? `on, ${i.hint_cost_pct}% each` : 'off'}</td>
                    <td>{when(i.expires_at)}</td>
                    <td>{i.attempt_id && <Link href={`/assessment/${i.attempt_id}`}>Open</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card" data-testid="practice">
        <h2>Practice lab</h2>
        {attempts === null ? (
          <p className="muted">Loading...</p>
        ) : current ? (
          <AttemptBoard attemptId={current.attempt_id} catalog={catalog} resultsAllowed={learnerResults} onChanged={load} />
        ) : (
          <>
            <p>Start an instance to get your own copy of the shop. Hints are free in practice and never lower your progress.</p>
            <p>
              <button type="button" onClick={async () => {
                setError('');
                try {
                  await api('POST', '/api/v1/instances', { kind: 'learner' });
                  await load();
                } catch (e) {
                  setError(say(e));
                }
              }}>Start an instance</button>
            </p>
            <div className="table-wrap">
              <table data-testid="catalogue">
                <thead><tr><th>Challenge</th><th>OWASP</th><th>Difficulty</th></tr></thead>
                <tbody>
                  {catalog.map((c) => (
                    <tr key={c.challenge_key}>
                      <td><strong>{c.challenge_key}</strong> {c.title}</td>
                      <td><span className="tag">2025 {c.owasp_2025}</span>{c.owasp_2021 && <span className="tag">2021 {c.owasp_2021}</span>}</td>
                      <td><Stars difficulty={c.difficulty} /> <span className="tag">{c.tier}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {practice.length > 1 && <p className="muted">Earlier practice attempts: {practice.filter((a) => a !== current).length}.</p>}
      </section>
    </>
  );
}
