'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, download, say, when, type DataView, type DeletionRequest } from '../../lib/api';
import { useRequireUser, useSession } from '../../lib/session';

// The account page (H-134, H-135, FR-DSH-04, FR-PRV-08, 09, 11): name, password, the authenticator app, a deletion request with its 7-day undo, and which
// companies viewed my data. The authenticator address and the recovery codes are shown once and kept only in this page's memory.
export default function AccountPage() {
  const user = useRequireUser();
  const { refresh } = useSession();
  const [banner, setBanner] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [requests, setRequests] = useState<DeletionRequest[]>([]);
  const [views, setViews] = useState<DataView[]>([]);

  const load = useCallback(async () => {
    try {
      const [r, v] = await Promise.all([
        api<{ items: DeletionRequest[] }>('GET', '/api/v1/me/deletion-requests'),
        api<{ items: DataView[] }>('GET', '/api/v1/me/data-views'),
      ]);
      setRequests(r.items);
      setViews(v.items);
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBanner(null);
    try {
      await fn();
      setBanner({ text: ok, kind: 'ok' });
      return true;
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
      return false;
    }
  }

  if (!user) return <p className="muted">Loading...</p>;
  const openLearner = requests.find((r) => r.kind === 'learner' && r.can_undo);

  return (
    <>
      <h1>Your account</h1>
      {banner && <p className={`banner ${banner.kind}`} role={banner.kind === 'bad' ? 'alert' : 'status'}>{banner.text}</p>}

      <section className="card">
        <h2>Profile</h2>
        <dl className="facts">
          <dt>Email</dt><dd>{user.email}</dd>
          <dt>Account</dt><dd>{user.account_type}</dd>
        </dl>
        <form
          onSubmit={async (ev: FormEvent<HTMLFormElement>) => {
            ev.preventDefault();
            const name = String(new FormData(ev.currentTarget).get('display_name') ?? '').trim();
            if (await act(() => api('PATCH', '/api/v1/me', { display_name: name }), 'Your name is saved.')) await refresh();
          }}
        >
          <label htmlFor="display_name">Name shown on your dashboard</label>
          <input id="display_name" name="display_name" type="text" defaultValue={user.display_name} maxLength={80} required />
          <p><button type="submit">Save</button></p>
        </form>
      </section>

      <section className="card">
        <h2>Password</h2>
        <form
          onSubmit={async (ev: FormEvent<HTMLFormElement>) => {
            ev.preventDefault();
            const form = ev.currentTarget;
            const f = new FormData(form);
            const ok = await act(() => api('POST', '/api/v1/me/password', { current_password: f.get('current'), new_password: f.get('next') }),
              'Your password is changed. Other sessions were signed out.');
            if (ok) {
              form.reset();
              await refresh();
            }
          }}
        >
          <label htmlFor="current">Current password</label>
          <input id="current" name="current" type="password" autoComplete="current-password" required />
          <label htmlFor="next">New password</label>
          <input id="next" name="next" type="password" autoComplete="new-password" minLength={12} required />
          <p><button type="submit">Change password</button></p>
        </form>
      </section>

      <section className="card" data-testid="mfa">
        <h2>Authenticator app</h2>
        {user.account_type === 'admin' && !user.mfa_enabled && (
          <p className="banner bad">An admin account needs an authenticator app before it can use the admin area. Set it up here.</p>
        )}
        {user.mfa_enabled ? (
          <form
            onSubmit={async (ev: FormEvent<HTMLFormElement>) => {
              ev.preventDefault();
              const password = new FormData(ev.currentTarget).get('password');
              if (await act(() => api('DELETE', '/api/v1/me/mfa', { password }), 'The authenticator app is turned off.')) await refresh();
            }}
          >
            <p>On. Sign-in asks for a code from your app.</p>
            <label htmlFor="mfa-password">Password, to turn it off</label>
            <input id="mfa-password" name="password" type="password" autoComplete="current-password" required />
            <p><button type="submit" className="danger">Turn off</button></p>
          </form>
        ) : otpauth ? (
          <form
            onSubmit={async (ev: FormEvent<HTMLFormElement>) => {
              ev.preventDefault();
              const code = String(new FormData(ev.currentTarget).get('code') ?? '').trim();
              setBanner(null);
              try {
                const r = await api<{ recovery_codes: string[] }>('POST', '/api/v1/me/mfa/confirm', { code });
                setOtpauth(null);
                setCodes(r.recovery_codes);
                await refresh();
              } catch (e) {
                setBanner({ text: say(e), kind: 'bad' });
              }
            }}
          >
            <p>Add this account to your authenticator app with the address below (most apps accept it pasted as a key URI), then enter the code it shows.</p>
            <p className="writeup" data-testid="otpauth">{otpauth}</p>
            <label htmlFor="code">Code from the app</label>
            <input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required />
            <p><button type="submit">Turn on</button></p>
          </form>
        ) : (
          <>
            <p>Off. An authenticator app makes your account harder to take over.</p>
            <button
              type="button"
              onClick={() => act(async () => setOtpauth((await api<{ otpauth_uri: string }>('POST', '/api/v1/me/mfa')).otpauth_uri), 'Scan or paste the address into your app.')}
            >
              Set up
            </button>
          </>
        )}
        {codes && (
          <div className="banner ok" data-testid="recovery-codes">
            <p>Your recovery codes. Each works once if you lose your phone. Write them down now: they are not shown again.</p>
            <ul className="code-list">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
            <button type="button" className="ghost" onClick={() => setCodes(null)}>I have saved them</button>
          </div>
        )}
      </section>

      {user.account_type === 'participant' && (
        <section className="card">
          <h2>Delete my account</h2>
          {openLearner ? (
            <>
              <p>Your account and practice data will be deleted on <strong>{when(openLearner.execute_after)}</strong>. Until then you can change your mind.</p>
              <button type="button" onClick={() => act(() => api('DELETE', `/api/v1/me/deletion-requests/${openLearner.request_id}`), 'The deletion is cancelled.').then(load)}>
                Keep my account
              </button>
            </>
          ) : (
            <>
              <p>Your practice data and your account are deleted 7 days after you ask; you can undo it until then. Assessment records are the inviting company&apos;s to delete: ask from the assessment.</p>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (window.confirm('Delete your account and practice data in 7 days?')) void act(() => api('POST', '/api/v1/me/deletion-requests', { kind: 'learner' }), 'Deletion requested.').then(load);
                }}
              >
                Delete my account
              </button>
            </>
          )}
          {requests.length > 0 && (
            <div className="table-wrap">
              <h3>Requests</h3>
              <table>
                <thead><tr><th>Kind</th><th>Company</th><th>Status</th><th>Deleted on</th></tr></thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.request_id}><td>{r.kind}</td><td>{r.company_name ?? '-'}</td><td>{r.status}</td><td>{when(r.execute_after)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card" data-testid="export">
        <h2>Download my data</h2>
        <p>A zip of JSON and CSV files: your profile, consents, attempts with results, timings, hints and the requests that captured flags, who viewed your data and your
          deletion requests. Flag values are never included.</p>
        <button type="button" onClick={() => act(() => download('/api/v1/me/exports', undefined, 'vulnmart-my-data.zip'), 'Your download has started.')}>Download my data</button>
      </section>

      <section className="card" data-testid="data-views">
        <h2>Who viewed my data</h2>
        {views.length === 0 ? (
          <p className="muted">No company has viewed or exported your data.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Company</th><th>What</th><th>When</th></tr></thead>
              <tbody>{views.map((v, i) => <tr key={i}><td>{v.company_name}</td><td>{v.action}</td><td>{when(v.at)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
