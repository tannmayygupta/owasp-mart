'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, download, say, when, type CatalogueItem, type CompanyDeletionRequest, type CompanyMember, type CompanyStanding, type CompanyTerms, type InvitesResult, type JoinRequest, type Template } from '../../lib/api';
import { useRequireUser } from '../../lib/session';
import { TemplateForm } from './template-form';

// The recruiter's company page (story P-27, FR-ORG-02, 07, FR-ASM-01, 02, 06; work package F): where the company stands, the data-processing terms, the assessment
// templates (new, edit, delete, export, the cohort view) and the invite form. Everything comes from the caller's own company routes; the API refuses another company's data.
const STATE_TEXT: Record<CompanyStanding['state'], string> = {
  none: 'You are not part of a company.',
  unverified_email: 'Confirm your email address first, with the link we sent.',
  pending_approval: 'Your company is waiting for an administrator to approve it. You can invite candidates once it is approved.',
  active: 'Your company is approved.',
  rejected: 'Your company was not approved.',
  suspended: 'Your company is suspended. Contact the VulnMart administrators.',
  deleted: 'Your company was deleted.',
};

export default function CompanyPage() {
  const user = useRequireUser();
  const [standing, setStanding] = useState<CompanyStanding | null>(null);
  const [terms, setTerms] = useState<CompanyTerms | null>(null);
  const [readTerms, setReadTerms] = useState<CompanyTerms | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [catalog, setCatalog] = useState<CatalogueItem[]>([]);
  const [result, setResult] = useState<InvitesResult | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [joins, setJoins] = useState<JoinRequest[]>([]);
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [deletions, setDeletions] = useState<CompanyDeletionRequest[]>([]);
  const [banner, setBanner] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api<CompanyStanding>('GET', '/api/v1/company');
      setStanding(s);
      setTerms(s.state === 'active' && s.role === 'owner' && !s.terms_accepted ? await api<CompanyTerms>('GET', '/api/v1/company/terms') : null);
      if (s.state === 'active') setTemplates((await api<{ items: Template[] }>('GET', '/api/v1/company/templates')).items);
      if (s.state === 'active' && s.terms_accepted) setDeletions((await api<{ items: CompanyDeletionRequest[] }>('GET', '/api/v1/company/deletion-requests')).items);
      if (s.state === 'active' && s.role === 'owner') {
        setJoins((await api<{ items: JoinRequest[] }>('GET', '/api/v1/company/join-requests')).items);
        setMembers((await api<{ items: CompanyMember[] }>('GET', '/api/v1/company/members')).items);
      }
      setCatalog((await api<{ items: CatalogueItem[] }>('GET', '/api/v1/challenges').catch(() => ({ items: [] as CatalogueItem[] }))).items);
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
    }
  }, []);

  useEffect(() => {
    if (user?.account_type === 'recruiter') void load();
  }, [user, load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBanner(null);
    try {
      await fn();
      setBanner({ text: ok, kind: 'ok' });
      await load();
      return true;
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
      return false;
    }
  }

  if (!user) return <p className="muted">Loading...</p>;
  if (user.account_type !== 'recruiter') return <p className="card">This page is for recruiters. <Link href="/dashboard">Back to your dashboard</Link></p>;
  if (!standing) return <p className="muted">Loading...</p>;
  const ready = standing.state === 'active' && standing.terms_accepted;
  const titles = Object.fromEntries(catalog.map((c) => [c.challenge_key, c.title]));

  return (
    <>
      <h1>{standing.company_name ?? 'Your company'}</h1>
      {banner && <p className={`banner ${banner.kind}`} role={banner.kind === 'bad' ? 'alert' : 'status'}>{banner.text}</p>}
      <section className="card" data-testid="standing" aria-label="Company profile">
        <dl className="facts">
          <dt>Company</dt><dd>{standing.company_name ?? '-'}</dd>
          <dt>Your role</dt><dd>{standing.role === 'owner' ? 'Owner' : standing.role === 'member' ? 'Member' : '-'}</dd>
          <dt>Standing</dt><dd>{STATE_TEXT[standing.state]}</dd>
          <dt>Data-processing terms</dt><dd data-testid="terms-state">{standing.terms_accepted ? 'Accepted by the owner' : 'Not accepted yet'}</dd>
        </dl>
        {standing.reason && <p className="muted">Reason given: {standing.reason}</p>}
        {standing.state === 'rejected' && standing.role === 'owner' && (
          <p><button type="button" onClick={() => act(() => api('POST', '/api/v1/company/reapply'), 'Applied again. An administrator will review it.')}>Apply again</button></p>
        )}
        {standing.state === 'active' && !standing.terms_accepted && standing.role !== 'owner' && <p>The company&apos;s owner has to accept the data-processing terms before anyone can invite.</p>}
        {standing.state === 'active' && standing.terms_accepted && standing.role === 'owner' && (
          <p>
            <button type="button" className="ghost" onClick={() => (readTerms ? setReadTerms(null) : void act(async () => setReadTerms(await api<CompanyTerms>('GET', '/api/v1/company/terms')), 'The terms are shown below.'))}>
              {readTerms ? 'Hide the terms' : 'Read the terms'}
            </button>
          </p>
        )}
        {readTerms && <p className="notice" data-testid="terms-text">{readTerms.text}</p>}
        {ready && <p><Link href="/company/candidates">Go to your candidates</Link></p>}
      </section>

      {terms && (
        <section className="card" data-testid="terms">
          <h2>Data-processing terms</h2>
          <p className="notice">{terms.text}</p>
          <button type="button" onClick={() => act(() => api('POST', '/api/v1/company/terms', { version: terms.version, sha256: terms.sha256 }), 'Thank you. You can invite candidates now.')}>
            I accept these terms for the company
          </button>
        </section>
      )}

      {ready && (
        <>
          <section className="card" data-testid="templates">
            <h2>Assessment templates</h2>
            {templates.length === 0 ? <p className="muted">No templates yet.</p> : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Assessment templates">
                <table>
                  <thead><tr><th>Title</th><th>Challenges</th><th>Time</th><th>Hints</th><th>Results</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {templates.map((t) => (
                      <tr key={t.template_id} data-template={t.title}>
                        <td>{t.title} <span className="tag">version {t.version}</span></td>
                        <td>{t.challenge_keys.join(', ')}</td>
                        <td>{t.time_limit_min} min</td>
                        <td>{t.hints_mode === 'on' ? `on, ${t.hint_cost_pct}%` : 'off'}</td>
                        <td>{t.results_visibility === 'after_submit' ? 'after submit' : 'when you release'}</td>
                        <td className="row">
                          <button type="button" className="ghost" aria-label={`Edit ${t.title}`} onClick={() => setEditing(editing === t.template_id ? null : t.template_id)}>Edit</button>
                          {t.cohort_board && <Link href={`/company/templates/${t.template_id}/cohort`} aria-label={`Cohort view of ${t.title}`}>Cohort view</Link>}
                          <button type="button" className="ghost" aria-label={`Export results of ${t.title}`} onClick={() => act(() => download('/api/v1/company/exports', { template_id: t.template_id }, 'vulnmart-results.zip'), 'Your download has started. The export is recorded.')}>
                            Export results
                          </button>
                          <button type="button" className="ghost" aria-label={`Delete ${t.title}`} onClick={() => { if (window.confirm(`Delete "${t.title}"?`)) void act(() => api('DELETE', `/api/v1/company/templates/${t.template_id}`), 'Template deleted.'); }}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {templates.filter((t) => t.template_id === editing).map((t) => (
              <div key={t.template_id} data-testid="template-edit">
                <h3>Edit &quot;{t.title}&quot;</h3>
                <p className="muted">Invitations already sent keep the rules they were made with. A change raises the template&apos;s version.</p>
                <TemplateForm idp={`edit-${t.template_id}`} initial={t} titles={titles} submitLabel="Save changes" onCancel={() => setEditing(null)}
                  onSubmit={async (body) => { const ok = await act(() => api('PUT', `/api/v1/company/templates/${t.template_id}`, body), 'Template saved.'); if (ok) setEditing(null); return ok; }} />
              </div>
            ))}
            <h3>New template</h3>
            <TemplateForm idp="new" titles={titles} submitLabel="Save template" onSubmit={(body) => act(() => api('POST', '/api/v1/company/templates', body), 'Template saved.')} />
          </section>

          <section className="card" data-testid="deletions" aria-labelledby="deletions-h">
            <h2 id="deletions-h">Candidates&apos; deletion requests</h2>
            <p className="muted">A candidate can ask you to delete their record. Approve it and the record is deleted after a 7-day hold (the candidate can undo until then); decline it and the candidate is told. If you do not decide in time, the request goes to the administrators.</p>
            {deletions.length === 0 ? <p className="muted">No open requests.</p> : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Deletion requests">
                <table>
                  <thead><tr><th>Candidate</th><th>Status</th><th>Asked</th><th>Decide by</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {deletions.map((d) => (
                      <tr key={d.request_id} data-request={d.request_id}>
                        <td>{d.candidate_email ?? d.attempt_id}</td>
                        <td><span className={`pill ${d.escalated ? 'warn' : ''}`}>{d.escalated ? 'with the administrators' : d.status}</span></td>
                        <td>{when(d.requested_at)}</td>
                        <td>{when(d.decide_by)}</td>
                        <td className="row">
                          {d.status === 'pending' && (
                            <>
                              <button type="button" aria-label={`Approve the deletion of ${d.candidate_email ?? d.attempt_id}`} onClick={() => act(() => api('POST', `/api/v1/company/deletion-requests/${d.request_id}/decision`, { decision: 'approve' }), 'Approved. The record is deleted after the 7-day hold.')}>Approve</button>
                              <button type="button" className="ghost" aria-label={`Decline the deletion of ${d.candidate_email ?? d.attempt_id}`} onClick={() => act(() => api('POST', `/api/v1/company/deletion-requests/${d.request_id}/decision`, { decision: 'decline' }), 'Declined. The candidate is told.')}>Decline</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {standing.role === 'owner' && (
            <section className="card" data-testid="colleagues" aria-labelledby="colleagues-h">
              <h2 id="colleagues-h">Colleagues</h2>
              <h3>Asked to join</h3>
              {joins.length === 0 ? <p className="muted">Nobody is waiting. A colleague with an address at your company&apos;s domain can sign up as a recruiter and ask to join.</p> : (
                <ul className="plain">
                  {joins.map((j) => (
                    <li key={j.request_id} className="row">
                      <span>{j.display_name} <span className="muted">asked {when(j.requested_at)}</span></span>
                      <button type="button" aria-label={`Let ${j.display_name} join`} onClick={() => act(() => api('POST', `/api/v1/company/join-requests/${j.request_id}/decision`, { decision: 'approve' }), `${j.display_name} joined.`)}>Approve</button>
                      <button type="button" className="ghost" aria-label={`Turn down ${j.display_name}`} onClick={() => act(() => api('POST', `/api/v1/company/join-requests/${j.request_id}/decision`, { decision: 'reject' }), 'The request was turned down.')}>Reject</button>
                    </li>
                  ))}
                </ul>
              )}
              <h3>Members</h3>
              <ul className="plain">
                {members.map((m) => (
                  <li key={m.user_id} className="row">
                    <span>{m.display_name} <span className="tag">{m.role}</span></span>
                    {m.role !== 'owner' && (
                      <button type="button" className="danger" aria-label={`Remove ${m.display_name}`}
                        onClick={() => { if (window.confirm(`Remove ${m.display_name} from the company?`)) void act(() => api('DELETE', `/api/v1/company/members/${m.user_id}`), `${m.display_name} was removed.`); }}>Remove</button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card" data-testid="invite">
            <h2>Invite candidates</h2>
            {templates.length === 0 ? <p className="muted">Make a template first.</p> : (
              <form
                onSubmit={async (ev: FormEvent<HTMLFormElement>) => {
                  ev.preventDefault();
                  const form = ev.currentTarget;
                  const f = new FormData(form);
                  const emails = String(f.get('emails') ?? '').split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
                  setResult(null);
                  const ok = await act(async () => setResult(await api<InvitesResult>('POST', '/api/v1/company/invites', { template_id: f.get('template_id'), emails })), 'Invitations sent.');
                  if (ok) form.reset();
                }}
              >
                <label htmlFor="template_id">Template</label>
                <select id="template_id" name="template_id" required>
                  {templates.map((t) => <option key={t.template_id} value={t.template_id}>{t.title}</option>)}
                </select>
                <label htmlFor="emails">Email addresses (one per line, up to 500)</label>
                <textarea id="emails" name="emails" rows={4} required />
                <p><button type="submit">Send invitations</button></p>
              </form>
            )}
            {result && (
              <div data-testid="invite-result">
                <p>Sent: {result.created.length}.{result.skipped.length > 0 && ` Skipped: ${result.skipped.length}.`}{result.remaining.length > 0 && ` Not sent today (daily limit ${result.cap ?? ''}): ${result.remaining.length}.`}</p>
                {result.skipped.length > 0 && <ul>{result.skipped.map((s) => <li key={s.email + s.reason}>{s.email}: {s.reason}</li>)}</ul>}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
