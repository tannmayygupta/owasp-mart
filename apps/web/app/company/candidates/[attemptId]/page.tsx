'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api, duration, say, timelineText, when, type CatalogueItem, type CompanyInvite, type Evidence, type IntegrityFlag, type Report, type TimelineEntry,
} from '../../../../lib/api';
import { useRequireUser } from '../../../../lib/session';
import { Stars } from '../../../attempt-board';

// One candidate's report for the recruiter (story P-27, FR-DSH-02, FR-HNT-03): total score of 1000, per challenge the points, time to capture, technique and tags,
// estimated active time, the evidence (the capturing request), the hints used with their cost when hints were on, and the integrity flags with the decision. The
// lab's reviewer routes check the company and record each view of the report and the evidence (story L-25). Never the person's practice history: only this attempt.
export default function CandidateReportPage() {
  const user = useRequireUser();
  const { attemptId } = useParams<{ attemptId: string }>();
  const [report, setReport] = useState<Report | null>(null);
  const [invite, setInvite] = useState<CompanyInvite | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [flags, setFlags] = useState<IntegrityFlag[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [catalog, setCatalog] = useState<CatalogueItem[]>([]);
  const [banner, setBanner] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, inv, ev, fl, tl, cat] = await Promise.all([
        api<Report>('GET', `/api/v1/attempts/${attemptId}/report`),
        api<{ items: CompanyInvite[] }>('GET', '/api/v1/company/invites'),
        api<{ items: Evidence[] }>('GET', `/api/v1/attempts/${attemptId}/evidence`).catch(() => ({ items: [] as Evidence[] })),
        api<{ items: IntegrityFlag[] }>('GET', `/api/v1/attempts/${attemptId}/integrity-flags`).catch(() => ({ items: [] as IntegrityFlag[] })),
        api<{ items: TimelineEntry[] }>('GET', `/api/v1/attempts/${attemptId}/timeline?limit=100`).catch(() => ({ items: [] as TimelineEntry[] })),
        api<{ items: CatalogueItem[] }>('GET', '/api/v1/challenges').catch(() => ({ items: [] as CatalogueItem[] })),
      ]);
      setReport(r);
      setInvite(inv.items.find((i) => i.attempt_id === attemptId) ?? null);
      setEvidence(ev.items);
      setFlags(fl.items);
      setTimeline(tl.items);
      setCatalog(cat.items);
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
    }
  }, [attemptId]);

  useEffect(() => {
    if (user?.account_type === 'recruiter') void load();
  }, [user, load]);

  async function decide(flag: IntegrityFlag, ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setBanner(null);
    try {
      await api('POST', `/api/v1/attempts/${attemptId}/integrity-flags/${flag.integrity_flag_id}/decision`, { decision: f.get('decision'), note: String(f.get('note') ?? '').trim() });
      setBanner({ text: 'Decision saved.', kind: 'ok' });
      await load();
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
    }
  }

  if (!user) return <p className="muted">Loading...</p>;
  if (user.account_type !== 'recruiter') return <p className="card">This page is for recruiters.</p>;
  if (!report) return <>{banner && <p className="banner bad" role="alert">{banner.text}</p>}<p className="muted">Loading the report...</p></>;
  const info = Object.fromEntries(catalog.map((c) => [c.challenge_key, c]));
  const hintsOn = invite?.hints_mode === 'on';

  return (
    <>
      <p><Link href="/company/candidates">Back to candidates</Link></p>
      <h1>{invite?.email ?? 'Candidate'}</h1>
      {banner && <p className={`banner ${banner.kind}`} role={banner.kind === 'bad' ? 'alert' : 'status'}>{banner.text}</p>}
      <section className="card" data-testid="report">
        <dl className="facts">
          <dt>Score</dt><dd><strong data-testid="report-score">{report.score}</strong> of 1000</dd>
          <dt>Attempt</dt><dd><span className="pill">{report.state}</span></dd>
          <dt>Elapsed</dt><dd>{duration(report.elapsed_seconds)}</dd>
          <dt>Estimated active time</dt><dd>{duration(report.active_seconds)}</dd>
          <dt>Hints</dt><dd>{hintsOn ? `${report.hints_used_total} used (the template set the hint cost at ${invite?.hint_cost_pct}%; the points above are after the cost)` : 'off for this assessment'}</dd>
          <dt>Open integrity flags</dt><dd>{report.integrity_open}</dd>
        </dl>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Challenge</th><th>Milestone</th><th>Points</th><th>Time to capture</th><th>Technique</th>{hintsOn && <th>Hints used</th>}</tr></thead>
            <tbody>
              {report.per_challenge.map((c) => (
                <tr key={c.challenge_key}>
                  <td>
                    <strong>{c.challenge_key}</strong> {info[c.challenge_key]?.title ?? ''}
                    {info[c.challenge_key] && <span className="tag">OWASP 2025 {info[c.challenge_key].owasp_2025}{info[c.challenge_key].owasp_2021 ? ` · 2021 ${info[c.challenge_key].owasp_2021}` : ''} · <Stars difficulty={info[c.challenge_key].difficulty} /></span>}
                  </td>
                  <td><span className={`pill ${c.best_milestone === 'M3' ? 'ok' : c.held ? 'warn' : ''}`}>{c.held ? 'held for review' : c.best_milestone}</span></td>
                  <td>{c.points}</td>
                  <td>{duration(c.time_to_capture_seconds)}</td>
                  <td>{c.technique_label ?? '-'}</td>
                  {hintsOn && <td>{c.hints_used} of 3</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" data-testid="evidence">
        <h2>Evidence</h2>
        {evidence.length === 0 ? <p className="muted">No captured request.</p> : evidence.map((e) => (
          <div key={e.evidence_id} className="stack">
            <p><strong>{e.challenge_key}</strong> · {when(e.captured_at)} · <code>{e.method} {e.path}</code></p>
            {e.body && <pre className="writeup">{e.body}{e.body_truncated ? '\n(cut)' : ''}</pre>}
          </div>
        ))}
      </section>

      <section className="card" data-testid="integrity">
        <h2>Integrity flags</h2>
        {flags.length === 0 ? <p className="muted">None.</p> : flags.map((fl) => (
          <div key={fl.integrity_flag_id} className="stack">
            <p><span className={`pill ${fl.status === 'open' ? 'warn' : ''}`}>{fl.status}</span> <strong>{fl.type}</strong>{fl.challenge_key ? ` on ${fl.challenge_key}` : ''}: {fl.explanation}</p>
            {fl.decision_note && <p className="muted">Note: {fl.decision_note}</p>}
            {fl.status === 'open' && (
              <form className="row" onSubmit={(ev) => decide(fl, ev)}>
                <select name="decision" aria-label="Decision"><option value="accept">Accept the capture</option><option value="reject">Reject the capture</option></select>
                <input name="note" placeholder="Why (required)" maxLength={500} required aria-label="Note" />
                <button type="submit">Decide</button>
              </form>
            )}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Timeline</h2>
        {timeline.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <ol>{timeline.map((t, i) => <li key={i} data-testid={t.type === 'attempt.time_warning' ? 'time-warning' : undefined}>{when(t.at)} {timelineText(t)}</li>)}</ol>
        )}
      </section>
    </>
  );
}
