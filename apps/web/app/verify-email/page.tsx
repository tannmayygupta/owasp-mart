'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, say } from '../../lib/api';
import { takeParam } from '../../lib/session';

// The link of the verification mail: `${public_origin}/verify-email?token=` (H-134). The token leaves the address bar at once.
export default function VerifyEmailPage() {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const token = takeParam('token') ?? '';
    api('POST', '/api/v1/accounts/verify-email', { token })
      .then(() => setState('done'))
      .catch((e) => {
        setMessage(say(e));
        setState('failed');
      });
  }, []);

  return (
    <div className="card narrow">
      <h1>Confirm your email</h1>
      {state === 'working' && <p className="muted">Checking the link...</p>}
      {state === 'done' && <p data-testid="verified">Your email is confirmed. You can <Link href="/login">sign in</Link> now.</p>}
      {state === 'failed' && <p className="banner bad" role="alert">{message} You can sign in and ask for a new link.</p>}
    </div>
  );
}
