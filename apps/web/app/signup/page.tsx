'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api, say } from '../../lib/api';

// Learner sign-up (FR-ACC-01, 18 and over): the answer is the same whether the address is new or known (no account enumeration); the mail says what to do.
export default function SignupPage() {
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/v1/accounts', {
        email: f.get('email'),
        password: f.get('password'),
        display_name: String(f.get('display_name') ?? '').trim(),
        age_declaration: f.get('age') === 'on',
      });
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
      </div>
    );
  }
  return (
    <div className="card narrow">
      <h1>Create an account</h1>
      {error && <p className="banner bad" role="alert">{error}</p>}
      <form onSubmit={onSubmit}>
        <label htmlFor="display_name">Name shown on your dashboard</label>
        <input id="display_name" name="display_name" type="text" autoComplete="nickname" maxLength={80} required />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
        <p className="muted">At least 12 characters. A long phrase is easiest to remember.</p>
        <label className="check" htmlFor="age">
          <input id="age" name="age" type="checkbox" required />
          <span>I am 18 or over.</span>
        </label>
        <p><button type="submit" disabled={busy}>Create account</button></p>
        <p className="muted">Already have one? <Link href="/login">Sign in</Link></p>
      </form>
    </div>
  );
}
