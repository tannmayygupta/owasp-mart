'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, say } from '../../lib/api';
import { takeParam } from '../../lib/session';

// The link mailed to a new email address (FR-ACC-09): `${public_origin}/confirm-email-change?token=`. The token leaves the address bar at once. On success every session of
// the account has ended on the server, so the person signs in again with the new address.
export default function ConfirmEmailChangePage() {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const token = takeParam('token') ?? '';
    api('POST', '/api/v1/accounts/confirm-email-change', { token })
      .then(() => setState('done'))
      .catch((e) => {
        setMessage(say(e));
        setState('failed');
      });
  }, []);

  return (
    <div className="card narrow">
      <h1>Confirm your new email address</h1>
      {state === 'working' && <p className="muted">Checking the link...</p>}
      {state === 'done' && <p data-testid="email-changed">Your email address is changed. Sign in again with the new address: <Link href="/login">sign in</Link>.</p>}
      {state === 'failed' && <p className="banner bad" role="alert">{message} Sign in and ask for a new link on your account page.</p>}
    </div>
  );
}