'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, say, type MfaRequired, type Session } from '../../lib/api';
import { afterSignIn } from '../../lib/paths';
import { useSession } from '../../lib/session';
import { AuthShell } from '../auth-shell';

// Sign-in (FR-ACC-03), then the second factor when the account has one (FR-ACC-07, H-135): the answer is `mfa_required` with a ticket, and the code
// (or a recovery code) completes it. After success the visitor goes back to where they came from (`next`, same-origin only).
export default function LoginPage() {
  const { adopt, user, loading } = useSession();
  const [ticket, setTicket] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) window.location.replace(afterSignIn(new URLSearchParams(window.location.search).get('next'), user.account_type));
  }, [loading, user]);

  function done(session: Session) {
    adopt(session);
    window.location.assign(afterSignIn(new URLSearchParams(window.location.search).get('next'), session.user.account_type));
  }

  async function onPassword(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setBusy(true);
    setError('');
    try {
      const r = await api<Session | MfaRequired>('POST', '/api/v1/session', { email: f.get('email'), password: f.get('password') });
      if (r.status === 'mfa_required') setTicket(r.mfa_ticket);
      else done(r);
    } catch (e) {
      setError(say(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCode(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setBusy(true);
    setError('');
    try {
      done(await api<Session>('POST', '/api/v1/session/mfa', { mfa_ticket: ticket, code: String(f.get('code') ?? '').trim() }));
    } catch (e) {
      setError(say(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h2>Sign in</h2>
      {error && <p className="banner bad" role="alert">{error}</p>}
      {!ticket ? (
        <form onSubmit={onPassword}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          <p><button type="submit" className="btn-block" disabled={busy}>Sign in</button></p>
          <p className="muted switch"><Link href="/forgot-password">Forgot your password?</Link> · <Link href="/signup">Create an account</Link></p>
        </form>
      ) : (
        <form onSubmit={onCode}>
          <p>Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
          <label htmlFor="code">Code</label>
          <input id="code" name="code" type="text" inputMode="text" autoComplete="one-time-code" maxLength={32} required />
          <p><button type="submit" className="btn-block" disabled={busy}>Continue</button></p>
        </form>
      )}
    </AuthShell>
  );
}
