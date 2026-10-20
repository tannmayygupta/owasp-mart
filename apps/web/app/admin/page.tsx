'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, say, when, type AdminSetting, type AdminUser, type Capacity, type JobStatus, type PendingCompany, type Quota } from '../../lib/api';
import { useRequireUser } from '../../lib/session';

// The admin dashboard (story P-30, FR-DSH-05) over the admin routes of story P-28: the approval queue, users, capacity, the retention jobs, settings, quotas and
// force-stop. Reading the users or the queue is audited by the server (every admin read of personal data is logged). The audit log and break-glass are story P-31.
// Only an admin with a second factor reaches these routes; anyone else gets "not found", and an admin without the factor is sent to set it up.
export default function AdminPage() {
  const user = useRequireUser();
  const [queue, setQueue] = useState<PendingCompany[]>([]);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [banner, setBanner] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);
  const [locked, setLocked] = useState(false);

  const load = useCallback(async () => {
    try {
      const [q, c, j, s, qu] = await Promise.all([
        api<{ items: PendingCompany[] }>('GET', '/api/v1/admin/companies/pending'),
        api<Capacity>('GET', '/api/v1/admin/capacity'),
        api<{ items: JobStatus[] }>('GET', '/api/v1/admin/jobs'),
        api<{ items: AdminSetting[] }>('GET', '/api/v1/admin/settings'),
        api<{ items: Quota[] }>('GET', '/api/v1/admin/quotas'),
      ]);
      setQueue(q.items);
      setCapacity(c);
      setJobs(j.items);
      setSettings(s.items);
      setQuotas(qu.items);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setLocked(true); // not an admin with a second factor in this session
      else setBanner({ text: say(e), kind: 'bad' });
    }
  }, []);

  useEffect(() => {
    if (user?.account_type === 'admin' && user.mfa_enabled) void load();
  }, [user, load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBanner(null);
    try {
      await fn();
      setBanner({ text: ok, kind: 'ok' });
      await load();
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
    }
  }

  if (!user) return <p className="muted">Loading...</p>;
  if (user.account_type !== 'admin') return <p className="card">This page is for administrators. <Link href="/dashboard">Back to your dashboard</Link></p>;
  if (!user.mfa_enabled || locked) {
    return (
      <div className="card" data-testid="admin-needs-mfa">
        <h1>Administration</h1>
        <p>The admin area needs your authenticator app in this session. Set it up on the <Link href="/account">account page</Link>, then sign in again with its code.</p>
      </div>
    );
  }

  return (
    <>
      <h1>Administration</h1>
      {banner && <p className={`banner ${banner.kind}`} role={banner.kind === 'bad' ? 'alert' : 'status'}>{banner.text}</p>}

      <section className="card" data-testid="queue">
        <h2>Companies waiting for approval</h2>
        {queue.length === 0 ? <p className="muted">None waiting.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Company</th><th>Owner</th><th>Applied</th><th /></tr></thead>
              <tbody>
                {queue.map((c) => (
                  <tr key={c.org_id}>
                    <td>{c.name}</td>
                    <td>{c.owner_name}<span className="tag">@{c.owner_email_domain}</span></td>
                    <td>{when(c.applied_at)}</td>
                    <td className="row">
                      <button type="button" onClick={() => act(() => api('POST', `/api/v1/admin/companies/${c.org_id}/decision`, { decision: 'approve' }), `${c.name} approved.`)}>Approve</button>
                      <button type="button" className="danger" onClick={() => {
                        const reason = window.prompt(`Why is ${c.name} rejected? The owner sees this.`);
                        if (reason) void act(() => api('POST', `/api/v1/admin/companies/${c.org_id}/decision`, { decision: 'reject', reason }), `${c.name} rejected.`);
                      }}>Reject</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" data-testid="users">
        <h2>Users</h2>
        <form className="row" onSubmit={(ev: FormEvent<HTMLFormElement>) => {
          ev.preventDefault();
          const q = String(new FormData(ev.currentTarget).get('q') ?? '').trim();
          void act(async () => setUsers((await api<{ items: AdminUser[] }>('GET', `/api/v1/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`)).items), 'Search done. The read is recorded in the audit log.');
        }}>
          <input name="q" placeholder="Name, email or user id" maxLength={80} aria-label="Search users" />
          <button type="submit">Search</button>
        </form>
        {users && (users.length === 0 ? <p className="muted">Nobody found.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.user_id}>
                    <td>{u.display_name}<span className="tag">{u.user_id}</span></td>
                    <td>{u.email}{!u.email_verified && <span className="tag">not confirmed</span>}</td>
                    <td>{u.account_type}<span className="tag">{u.roles.join(', ')}</span></td>
                    <td><span className="pill">{u.status}</span></td>
                    <td>{when(u.last_login_at)}</td>
                    <td className="row">
                      {u.account_type !== 'admin' && (['lock', 'unlock', 'reset_password', 'delete'] as const).map((action) => (
                        <button key={action} type="button" className={action === 'delete' ? 'danger' : 'ghost'} onClick={() => {
                          const needsReason = action !== 'reset_password';
                          const reason = needsReason ? window.prompt(`Why ${action} ${u.display_name}? (recorded, not shown to them)`) : null;
                          if (needsReason && !reason) return;
                          void act(() => api('POST', `/api/v1/admin/users/${u.user_id}/actions`, needsReason ? { action, reason } : { action }), `${action.replace('_', ' ')}: done.`);
                        }}>{action.replace('_', ' ')}</button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section className="card" data-testid="capacity">
        <h2>Capacity</h2>
        {capacity && (
          <dl className="facts">
            <dt>Instances running</dt><dd>{capacity.instances.running} ({capacity.instances.reported} reported, {capacity.instances.failed} failed)</dd>
            <dt>Memory</dt><dd>{capacity.memory ? `${capacity.memory.used_mb} of ${capacity.memory.capacity_mb} MB, ${capacity.memory.health}` : 'no lab host in this process'}</dd>
            <dt>Queue</dt><dd>{capacity.queue.emails_waiting} emails waiting, {capacity.queue.events_unpublished} events not relayed</dd>
            <dt>Failures</dt><dd>{capacity.failures.emails_failed} emails, {capacity.failures.jobs_failed} jobs, {capacity.failures.instances_failed} instances</dd>
          </dl>
        )}
        <form className="row" onSubmit={(ev: FormEvent<HTMLFormElement>) => {
          ev.preventDefault();
          const id = String(new FormData(ev.currentTarget).get('attempt') ?? '').trim();
          if (id && window.confirm(`Force-stop the instance of ${id}? Its owner is told by email.`)) void act(() => api('POST', `/api/v1/admin/attempts/${id}/force-stop`), 'Instance stopped.');
        }}>
          <input name="attempt" placeholder="Attempt id (a-...)" pattern="a-[A-Z2-7]{16}" aria-label="Attempt id to force-stop" />
          <button type="submit" className="danger">Force-stop</button>
        </form>
      </section>

      <section className="card" data-testid="jobs">
        <h2>Retention and scheduled jobs</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Job</th><th>Last run</th><th>Result</th><th>Next</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.name}>
                  <td>{j.name}</td>
                  <td>{when(j.last_started_at)}</td>
                  <td><span className={`pill ${j.last_status === 'failed' ? 'bad' : j.last_status === 'succeeded' ? 'ok' : ''}`}>{j.last_status ?? 'not run'}</span>{j.last_detail && <span className="tag">{j.last_detail}</span>}</td>
                  <td>{when(j.next_due_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" data-testid="settings">
        <h2>Settings</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Setting</th><th>Value</th><th>Default</th><th /></tr></thead>
            <tbody>
              {settings.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}{s.minimum !== null && <span className="tag">{s.minimum} to {s.maximum}</span>}</td>
                  <td>
                    <form className="row" onSubmit={(ev: FormEvent<HTMLFormElement>) => {
                      ev.preventDefault();
                      const raw = String(new FormData(ev.currentTarget).get('v') ?? '');
                      const value = typeof s.default === 'number' ? Number(raw) : typeof s.default === 'boolean' ? raw === 'true' : raw;
                      void act(() => api('PUT', `/api/v1/admin/settings/${s.name}`, { value }), `${s.name} saved.`);
                    }}>
                      <input name="v" defaultValue={String(s.value)} aria-label={s.name} />
                      <button type="submit" className="ghost">Save</button>
                    </form>
                  </td>
                  <td>{String(s.default)}</td>
                  <td>{s.overridden && <button type="button" className="ghost" onClick={() => act(() => api('DELETE', `/api/v1/admin/settings/${s.name}`), `${s.name} reset.`)}>Reset</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" data-testid="quotas">
        <h2>Instance quotas</h2>
        {quotas.length === 0 ? <p className="muted">No quota set: one instance per person.</p> : (
          <ul>{quotas.map((q) => (
            <li key={`${q.scope}-${q.scope_id}`}>
              {q.scope}{q.scope_id ? ` ${q.scope_id}` : ''}: {q.max_instances}{' '}
              <button type="button" className="ghost" onClick={() => act(() => api('DELETE', `/api/v1/admin/quotas?scope=${q.scope}${q.scope_id ? `&scope_id=${encodeURIComponent(q.scope_id)}` : ''}`), 'Quota removed.')}>Remove</button>
            </li>
          ))}</ul>
        )}
        <form className="row" onSubmit={(ev: FormEvent<HTMLFormElement>) => {
          ev.preventDefault();
          const f = new FormData(ev.currentTarget);
          const scope = String(f.get('scope'));
          const id = String(f.get('scope_id') ?? '').trim();
          void act(() => api('PUT', '/api/v1/admin/quotas', { scope, ...(scope === 'global' ? {} : { scope_id: id }), max_instances: Number(f.get('max')) }), 'Quota saved.');
        }}>
          <select name="scope" aria-label="Scope"><option value="global">Everyone</option><option value="org">A company (id)</option><option value="user">A user (id)</option></select>
          <input name="scope_id" placeholder="Company or user id" aria-label="Company or user id" />
          <input name="max" placeholder="Instances" inputMode="numeric" required aria-label="Instances at once" />
          <button type="submit">Set</button>
        </form>
      </section>

      <section className="card">
        <h2>Audit log and break-glass</h2>
        <p className="muted">Reading the audit log and break-glass access to a candidate&apos;s answers come with the next story (P-31).</p>
      </section>
    </>
  );
}
