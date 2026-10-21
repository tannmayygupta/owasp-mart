'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, duration, say, when, type CompanyInvite, type Template, type TemplateCohort } from '../../../../../lib/api';
import { useRequireUser } from '../../../../../lib/session';

// The private cohort view and ranking aid of one assessment (story L-28, FR-SCR-07 and 08, D-93, ADR 0072). It lists the candidates of this assessment whose attempt has
// ended, in a suggested order (score, full captures, hint cost, active time, last capture). It is an aid: nobody is dropped from it or marked failed, no hiring decision is
// made here, and it exists only for this company and this assessment (no global list). The rows carry attempt ids; the names are the company's own invites.
export default function CohortPage() {
  const user = useRequireUser();
  const { templateId } = useParams<{ templateId: string }>();
  const [board, setBoard] = useState<TemplateCohort | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [invites, setInvites] = useState<CompanyInvite[]>([]);
  const [error, setError] = useState('');
  const [off, setOff] = useState(false);

  const load = useCallback(async () => {
    try {
      setTemplate(await api<Template>('GET', `/api/v1/company/templates/${templateId}`));
      setInvites((await api<{ items: CompanyInvite[] }>('GET', `/api/v1/company/invites?template_id=${templateId}`)).items);
      setBoard(await api<TemplateCohort>('GET', `/api/v1/company/templates/${templateId}/cohort`));
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ATT-INVALID-STATE') setOff(true); // the template keeps the board off
      else setError(say(e));
    }
  }, [templateId]);

  useEffect(() => {
    if (user?.account_type === 'recruiter') void load();
  }, [user, load]);

  if (!user) return <p className="muted">Loading...</p>;
  if (user.account_type !== 'recruiter') return <p className="card">This page is for recruiters. <Link href="/dashboard">Back to your dashboard</Link></p>;
  const who = (attemptId: string) => invites.find((i) => i.attempt_id === attemptId)?.email ?? attemptId;

  return (
    <>
      <p><Link href="/company">Back to the company page</Link></p>
      <h1>Cohort view{template ? `: ${template.title}` : ''}</h1>
      {error && <p className="banner bad" role="alert">{error}</p>}
      {off && <p className="card" data-testid="cohort-off">The cohort view is off for this assessment. Turn it on in the template (Edit, then the cohort view option).</p>}
      {board && (
        <section className="card" data-testid="cohort">
          <p className="notice" data-testid="cohort-label">This is a {board.label}. The order is a suggestion to help you read the results: nobody is ranked out, and the decision is yours. It is private to your company and shows only this assessment.</p>
          {board.items.length === 0 ? <p className="muted">No candidate has finished yet. A candidate appears here after submitting, once no capture is waiting for your review.</p> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Candidates in the suggested order">
              <table>
                <caption className="sr-only">Candidates in the suggested order</caption>
                <thead><tr><th>Position</th><th>Candidate</th><th>Score</th><th>Full captures</th><th>Hint cost</th><th>Active time</th><th>Last capture</th><th>Why before the next</th><th><span className="sr-only">Report</span></th></tr></thead>
                <tbody>
                  {board.items.map((r) => (
                    <tr key={r.attempt_id} data-attempt={r.attempt_id}>
                      <td>{r.position}</td>
                      <td>{who(r.attempt_id)}</td>
                      <td>{r.score} of 1000</td>
                      <td>{r.full_captures}</td>
                      <td>{r.hint_cost_units}</td>
                      <td>{duration(r.active_seconds)}</td>
                      <td>{when(r.last_capture_at)}</td>
                      <td>{r.reason}</td>
                      <td><Link href={`/company/candidates/${r.attempt_id}`} aria-label={`Report of ${who(r.attempt_id)}`}>Report</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
