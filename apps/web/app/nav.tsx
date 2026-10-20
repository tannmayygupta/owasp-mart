'use client';

import Link from 'next/link';
import { useSession } from '../lib/session';

export function Nav() {
  const { user, loading, signOut } = useSession();
  return (
    <header className="nav">
      <Link href="/" className="brand">VulnMart</Link>
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
