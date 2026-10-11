'use client';

import { useEffect, useState } from 'react';

type Health = { status: string; postgres: string; valkey: string };
type State = { kind: 'loading' } | { kind: 'done'; health: Health } | { kind: 'unreachable' };

// Same-origin call: the browser asks this page's own origin; next.config.mjs forwards it to the API.
async function loadHealth(): Promise<State> {
  try {
    // A hung proxy must end in "unreachable", not in an endless "Checking the API...".
    const res = await fetch('/api/healthz', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as Partial<Health>; // 200 and 503 both carry the three fields
    if (typeof body?.status === 'string' && typeof body.postgres === 'string' && typeof body.valkey === 'string') {
      return { kind: 'done', health: body as Health };
    }
  } catch {
    // fall through
  }
  return { kind: 'unreachable' };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li>
      {label}: <strong data-testid={`health-${label.toLowerCase()}`}>{value}</strong>
    </li>
  );
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
      {state.kind === 'unreachable' && (
        <ul>
          <Row label="API" value="unreachable" />
        </ul>
      )}
      {state.kind === 'done' && (
        <ul>
          <Row label="API" value={state.health.status} />
          <Row label="Postgres" value={state.health.postgres} />
          <Row label="Valkey" value={state.health.valkey} />
        </ul>
      )}
    </main>
  );
}
