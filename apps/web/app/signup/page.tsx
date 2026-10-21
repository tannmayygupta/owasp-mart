'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api, say } from '../../lib/api';
import { AuthShell } from '../auth-shell';

// Sign-up (FR-ACC-01, FR-ORG-01): a learner (18 and over), or a recruiter with the company's name (the company waits for an admin's approval, story P-18). The
// answer is the same whether the address is new or known (no account enumeration); the mail says what to do.
export default function SignupPage() {
  const [kind, setKind] = useState<'learner' | 'recruiter'>('learner');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const common = { email: f.get('email'), password: f.get('password'), display_name: String(f.get('display_name') ?? '').trim() };
    setBusy(true);
    setError('');
    try {
      if (kind === 'recruiter') await api('POST', '/api/v1/recruiters', { ...common, company_name: String(f.get('company_name') ?? '').trim() });
      else await api('POST', '/api/v1/accounts', { ...common, age_declaration: f.get('age') === 'on' });
      setSent(true);
    } catch (e) {
      setError(say(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="card narrow" data-testid="signup-sent">
        <h1>Check your email</h1>
        <p>We sent a link to confirm your address. Open it, then <Link href="/login">sign in</Link>.</p>
        {kind === 'recruiter' && <p className="muted">After you confirm, an administrator reviews your company before you can invite candidates.</p>}
      </div>
    );
  }
  return (
    <AuthShell>
      <h2>Create an account</h2>
      <div className="segmented" role="radiogroup" aria-label="Account type">
        <label><input type="radio" name="kind" checked={kind === 'learner'} onChange={() => setKind('learner')} /> <span>I want to practise</span></label>
        <label><input type="radio" name="kind" checked={kind === 'recruiter'} onChange={() => setKind('recruiter')} /> <span>I recruit for a company</span></label>
      </div>
      {error && <p className="banner bad" role="alert">{error}</p>}
      <form onSubmit={onSubmit}>
        <label htmlFor="display_name">{kind === 'recruiter' ? 'Your name' : 'Name shown on your dashboard'}</label>
        <input id="display_name" name="display_name" type="text" autoComplete="nickname" maxLength={60} required />
        {kind === 'recruiter' && (
          <>
            <label htmlFor="company_name">Company</label>
            <input id="company_name" name="company_name" type="text" autoComplete="organization" maxLength={120} required />
          </>
        )}
        <label htmlFor="email">{kind === 'recruiter' ? 'Work email' : 'Email'}</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
        <p className="muted">At least 12 characters. A long phrase is easiest to remember.</p>
        {kind === 'learner' && (
          <label className="check" htmlFor="age">
            <input id="age" name="age" type="checkbox" required />
            <span>I am 18 or over, and I will only attack the lab, never anything else.</span>
          </label>
        )}
        <p><button type="submit" className="btn-block" disabled={busy}>Create account</button></p>
        <p className="muted switch">Already have one? <Link href="/login">Sign in</Link></p>
      </form>
    </AuthShell>
  );
}
