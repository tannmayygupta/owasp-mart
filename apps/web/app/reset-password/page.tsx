'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, say } from '../../lib/api';
import { takeParam } from '../../lib/session';

// The link of the reset mail: `${public_origin}/reset-password?token=` (H-134). A refused password answers a fixed sentence, shown as it is.
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setToken(takeParam('token') ?? '');
  }, []);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setError('');
    try {
      await api('POST', '/api/v1/password-reset/confirm', { token, new_password: f.get('password') });
      setDone(true);
    } catch (e) {
      setError(say(e));
    }
  }

  return (
    <div className="card narrow">
      <h1>Choose a new password</h1>
      {done ? (
        <p data-testid="reset-done">Your password is changed and every session was signed out. <Link href="/login">Sign in</Link> with the new one.</p>
      ) : (
        <form onSubmit={onSubmit}>
          {error && <p className="banner bad" role="alert">{error}</p>}
          <label htmlFor="password">New password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
          <p><button type="submit" disabled={token === null}>Save the password</button></p>
        </form>
      )}
    </div>
  );
}
