'use client';

import { useState, type FormEvent } from 'react';
import { api, say } from '../../lib/api';

// Password reset request (FR-ACC-04): always the same answer, whether the address has an account or not.
export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setError('');
    try {
      await api('POST', '/api/v1/password-reset/request', { email: f.get('email') });
      setSent(true);
    } catch (e) {
      setError(say(e));
    }
  }

  return (
    <div className="card narrow">
      <h1>Reset your password</h1>
      {sent ? (
        <p data-testid="reset-sent">If an account uses that address, we sent it a link to choose a new password.</p>
      ) : (
        <form onSubmit={onSubmit}>
          {error && <p className="banner bad" role="alert">{error}</p>}
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
          <p><button type="submit">Send the link</button></p>
        </form>
      )}
    </div>
  );
}
