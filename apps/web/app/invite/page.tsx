'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, say, when, type InviteSummary, type MyInvite } from '../../lib/api';
import { useSession } from '../../lib/session';

// The page the invite mail links to (FR-ASM-04, story P-26): what the assessment is, then sign in (or create an account) with the invited address and accept.
// The token leaves the address bar at once and is kept for this tab only (sessionStorage), so it survives the detour to the sign-in page; it is removed after
// accepting. Consent follows on the assessment page.
const KEY = 'vm-invite-token';

function readToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token');
  try {
    if (fromUrl) {
      window.sessionStorage.setItem(KEY, fromUrl);
      window.history.replaceState(null, '', '/invite');
      return fromUrl;
    }
    return window.sessionStorage.getItem(KEY);
  } catch {
    return fromUrl; // storage blocked: the token still works on this load
  }
}

function forget() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

const CLOSED: Record<string, string> = {
  expired: 'This invite has expired. Ask the company for a new one.',
  cancelled: 'The company cancelled this invite.',
  revoked: 'The company withdrew this invite.',
  declined: 'You declined this assessment.',
};

export default function InvitePage() {
  const { user, loading } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const [summary, setSummary] = useState<InviteSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const t = readToken();
    setToken(t);
    if (!t) {
      setError('Open the link from your invite email.');
      return;
    }
    api<InviteSummary>('POST', '/api/v1/invites/open', { token: t }).then(setSummary).catch((e) => setError(say(e)));
  }, []);

  async function accept() {
    setBusy(true);
    setError('');
    try {
      const r = await api<MyInvite>('POST', '/api/v1/invites/accept', { token });
      forget();
      window.location.assign(`/assessment/${r.attempt_id}`);
    } catch (e) {
      setError(e instanceof Error && e.message === 'ATT-INVALID-STATE'
        ? 'This invite cannot be accepted with this account. It may be closed or already accepted, or it was sent to another email address: sign in with the address the invite was sent to.'
        : say(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card narrow">
      <h1>Your invitation</h1>
      {error && <p className="banner bad" role="alert">{error}</p>}
      {summary && (
        <>
          <p><strong>{summary.company_name}</strong> invited you to the assessment <strong>{summary.title}</strong>.</p>
          <dl className="facts" data-testid="invite-summary">
            <dt>Challenges</dt><dd>{summary.challenge_count}</dd>
            <dt>Time limit</dt><dd>{summary.time_limit_min ? `${summary.time_limit_min} minutes, from when you start` : '-'}</dd>
            <dt>Hints</dt><dd>{summary.hints_mode === 'on' ? `allowed, each costs ${summary.hint_cost_pct}% of that challenge's points` : 'none'}</dd>
            <dt>Write-up</dt><dd>{summary.writeup_required ? 'required' : 'optional'}</dd>
            <dt>Your results</dt><dd>{summary.results_visibility === 'after_submit' ? 'shown to you when you submit' : 'shown when the company releases them'}</dd>
            <dt>Link expires</dt><dd>{when(summary.expires_at)}</dd>
          </dl>
          {CLOSED[summary.state] ? (
            <p className="banner bad">{CLOSED[summary.state]}</p>
          ) : loading ? null : user ? (
            <>
              <p>Signed in as {user.email}. Accepting shows you the privacy notice next; nothing starts until you agree and press Start.</p>
              <p><button type="button" onClick={accept} disabled={busy}>Accept the invitation</button></p>
            </>
          ) : (
            <p>
              <Link href="/login?next=/invite">Sign in</Link> or <Link href="/signup">create an account</Link> with the address this invite was sent to. After
              confirming a new account, open the invite link again.
            </p>
          )}
        </>
      )}
    </div>
  );
}
