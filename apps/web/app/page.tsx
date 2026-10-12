'use client';

import { useEffect, useState } from 'react';

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

  useEffect(() => {
    loadHealth().then(setState);
  }, []);

  return (
    <main>
      <h1>VulnMart platform</h1>
      {state.kind === 'loading' && <p>Checking the API...</p>}
      <ul>
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
    </main>
  );
}
