'use client';

import Link from 'next/link';
import { useSession } from '../lib/session';

export function Nav() {
  const { user, loading, signOut } = useSession();
  return (
    <header className="nav">
      <div className="row">
        <Link href="/" className="brand">
          <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" className="logo-bg" /><path d="M9 10l7 13 7-13" className="logo-v" /><circle cx="16" cy="23" r="2.2" className="logo-dot" /></svg>
          <span>VulnMart</span>
        </Link>
        <span className="sandbox-tag" title="Everything you attack here is a private copy built to be broken">Sandbox</span>
      </div>
      <nav>
        {!loading && user && (
          <>
            <Link href="/dashboard">Dashboard</Link>
            {user.account_type === 'recruiter' && <Link href="/company/candidates">Candidates</Link>}
            {user.account_type === 'recruiter' && <Link href="/company">Company</Link>}
            {user.account_type === 'admin' && <Link href="/admin">Admin</Link>}
            <Link href="/account">Account</Link>
            <span className="muted" data-testid="who">{user.display_name}</span>
            <button
              type="button"
              className="ghost"
              onClick={async () => {
                await signOut();
                window.location.assign('/login');
              }}
            >
              Sign out
            </button>
          </>
        )}
        {!loading && !user && (
          <>
            <Link href="/login">Sign in</Link>
            <Link href="/signup">Create account</Link>
          </>
        )}
      </nav>
    </header>
  );
}
