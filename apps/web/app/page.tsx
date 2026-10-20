'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from '../lib/session';

// GET /api/v1/health (IF-1 getHealth): `ok` or `degraded`, never which store is down.
type Health = { status: 'ok' | 'degraded' };
type State = { kind: 'loading' } | { kind: 'done'; health: Health } | { kind: 'unreachable' };

// Same-origin call: the browser asks this page's own origin; proxy.ts forwards it to the API with the origin secret.
async function loadHealth(): Promise<State> {
  try {
    // A hung proxy must end in "unreachable", not in an endless "Checking the API...".
    const res = await fetch('/api/v1/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as Partial<Health>; // 200 and 503 both carry the status
    if (body?.status === 'ok' || body?.status === 'degraded') {
      return { kind: 'done', health: { status: body.status } };
    }
  } catch {
    // fall through
  }
  return { kind: 'unreachable' };
}

export default function Page() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const { user, loading } = useSession();

  useEffect(() => {
    loadHealth().then(setState);
  }, []);

  return (
    <>
      <h1>VulnMart</h1>
      <div className="card">
        <p>Practise finding and fixing the OWASP Top 10 in a shop that is vulnerable on purpose, or take an assessment you were invited to.</p>
        {!loading && (user ? (
          <p><Link href="/dashboard">Go to your dashboard</Link></p>
        ) : (
          <p className="row"><Link href="/login">Sign in</Link> <Link href="/signup">Create an account</Link></p>
        ))}
      </div>
      {state.kind === 'loading' && <p className="muted">Checking the API...</p>}
      <ul className="muted">
        {state.kind === 'unreachable' && (
          <li>
            API: <strong data-testid="health-api">unreachable</strong>
          </li>
        )}
        {state.kind === 'done' && (
          <li>
            API: <strong data-testid="health-api">{state.health.status}</strong>
          </li>
        )}
      </ul>
    </>
  );
}
