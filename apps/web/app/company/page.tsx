'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, download, say, type CatalogueItem, type CompanyStanding, type CompanyTerms, type InvitesResult, type Template } from '../../lib/api';
import { useRequireUser } from '../../lib/session';

// The recruiter's company page (story P-27, FR-ORG-02, 07, FR-ASM-01, 02, 06): where the company stands, the data-processing terms for the owner, the assessment
// templates and the invite form. Everything comes from the caller's own company routes; the API refuses another company's data.
const STATE_TEXT: Record<CompanyStanding['state'], string> = {
  none: 'You are not part of a company.',
  unverified_email: 'Confirm your email address first, with the link we sent.',
  pending_approval: 'Your company is waiting for an administrator to approve it. You can invite candidates once it is approved.',
  active: 'Your company is approved.',
  rejected: 'Your company was not approved.',
  suspended: 'Your company is suspended. Contact the VulnMart administrators.',
  deleted: 'Your company was deleted.',
};

const ALL_KEYS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'];

export default function CompanyPage() {
  const user = useRequireUser();
  const [standing, setStanding] = useState<CompanyStanding | null>(null);
  const [terms, setTerms] = useState<CompanyTerms | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [catalog, setCatalog] = useState<CatalogueItem[]>([]);
  const [result, setResult] = useState<InvitesResult | null>(null);
  const [banner, setBanner] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api<CompanyStanding>('GET', '/api/v1/company');
      setStanding(s);
      setTerms(s.state === 'active' && s.role === 'owner' && !s.terms_accepted ? await api<CompanyTerms>('GET', '/api/v1/company/terms') : null);
      if (s.state === 'active') setTemplates((await api<{ items: Template[] }>('GET', '/api/v1/company/templates')).items);
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
      <section className="card" data-testid="standing">
        <p>{STATE_TEXT[standing.state]}</p>
        {standing.reason && <p className="muted">Reason given: {standing.reason}</p>}
        {standing.state === 'rejected' && standing.role === 'owner' && (
          <button type="button" onClick={() => act(() => api('POST', '/api/v1/company/reapply'), 'Applied again. An administrator will review it.')}>Apply again</button>
        )}
        {standing.state === 'active' && !standing.terms_accepted && standing.role !== 'owner' && <p>The company&apos;s owner has to accept the data-processing terms before anyone can invite.</p>}
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
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Title</th><th>Challenges</th><th>Time</th><th>Hints</th><th>Results</th><th /></tr></thead>
                  <tbody>
                    {templates.map((t) => (
                      <tr key={t.template_id}>
                        <td>{t.title} <span className="tag">version {t.version}</span></td>
                        <td>{t.challenge_keys.join(', ')}</td>
                        <td>{t.time_limit_min} min</td>
                        <td>{t.hints_mode === 'on' ? `on, ${t.hint_cost_pct}%` : 'off'}</td>
                        <td>{t.results_visibility === 'after_submit' ? 'after submit' : 'when you release'}</td>
                        <td className="row">
                          <button type="button" className="ghost" onClick={() => act(() => download('/api/v1/company/exports', { template_id: t.template_id }, 'vulnmart-results.zip'), 'Your download has started. The export is recorded.')}>
                            Export results
                          </button>
                          <button type="button" className="ghost" onClick={() => { if (window.confirm(`Delete "${t.title}"?`)) void act(() => api('DELETE', `/api/v1/company/templates/${t.template_id}`), 'Template deleted.'); }}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3>New template</h3>
            <form
              onSubmit={async (ev: FormEvent<HTMLFormElement>) => {
                ev.preventDefault();
                const form = ev.currentTarget;
                const f = new FormData(form);
                const keys = ALL_KEYS.filter((k) => f.get(`key-${k}`) === 'on');
                const hints = f.get('hints') === 'on';
                const ok = await act(() => api('POST', '/api/v1/company/templates', {
                  title: String(f.get('title') ?? '').trim(),
                  challenge_keys: keys,
                  time_limit_min: Number(f.get('time_limit_min')),
                  hints_mode: hints ? 'on' : 'off',
                  ...(hints ? { hint_cost_pct: Number(f.get('hint_cost_pct')) } : {}),
                  results_visibility: f.get('results') === 'after_release' ? 'after_release' : 'after_submit',
                  writeup_required: f.get('writeup') === 'on',
                }), 'Template saved.');
                if (ok) form.reset();
              }}
            >
              <label htmlFor="title">Title</label>
              <input id="title" name="title" type="text" maxLength={200} required />
              <fieldset>
                <legend>Challenges</legend>
                <div className="row">
                  {ALL_KEYS.map((k) => (
                    <label key={k} className="check"><input type="checkbox" name={`key-${k}`} /> <span>{k} {titles[k] ?? ''}</span></label>
                  ))}
                </div>
              </fieldset>
              <label htmlFor="time_limit_min">Time limit (minutes, 30 to 480)</label>
              <input id="time_limit_min" name="time_limit_min" type="text" inputMode="numeric" defaultValue="120" required />
              <label className="check"><input type="checkbox" name="hints" /> <span>Allow hints</span></label>
              <label htmlFor="hint_cost_pct">Cost of each hint (percent of the challenge&apos;s points, 0 to 100)</label>
              <input id="hint_cost_pct" name="hint_cost_pct" type="text" inputMode="numeric" defaultValue="10" />
              <label className="check"><input type="checkbox" name="writeup" /> <span>Require a write-up</span></label>
              <label className="check"><input type="radio" name="results" value="after_submit" defaultChecked /> <span>Candidates see their results when they submit</span></label>
              <label className="check"><input type="radio" name="results" value="after_release" /> <span>Candidates see their results when you release them</span></label>
              <p><button type="submit">Save template</button></p>
            </form>
          </section>

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
