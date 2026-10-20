'use client';

// Who is signed in, for every page (story P-26). Read from getSession once per page load; sign-in and sign-out update it. The CSRF token goes to lib/api.ts and
// nowhere else (never into storage). A page that needs a session sends the visitor to /login and comes back afterwards (`next`, same-origin paths only).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, setCsrf, type Session, type User } from './api';

type SessionState = {
  user: User | null;
  loading: boolean;
  adopt: (session: Session) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const adopt = useCallback((session: Session) => {
    setCsrf(session.csrf_token);
    setUser(session.user);
  }, []);

  const refresh = useCallback(async () => {
    try {
      adopt(await api<Session>('GET', '/api/v1/session'));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status === 401) {
        setCsrf(null);
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [adopt]);

  const signOut = useCallback(async () => {
    try {
      await api('DELETE', '/api/v1/session');
    } catch {
      // the session may be gone already
    }
    setCsrf(null);
    setUser(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ user, loading, adopt, refresh, signOut }), [user, loading, adopt, refresh, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

export { safeNext } from './paths';

/** Sends a visitor without a session to the sign-in page, remembering where they were. */
export function useRequireUser(): User | null {
  const { user, loading } = useSession();
  useEffect(() => {
    if (!loading && !user) {
      const here = window.location.pathname + window.location.search;
      window.location.replace(`/login?next=${encodeURIComponent(here)}`);
    }
  }, [user, loading]);
  return user;
}

/** Reads one query parameter and removes the query from the address bar (link tokens must not stay in the history or reach a Referer). */
export function takeParam(name: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(name);
  if (value !== null && name === 'token') window.history.replaceState(null, '', window.location.pathname);
  return value;
}
