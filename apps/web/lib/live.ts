'use client';

// Live updates for a page (FR-LIV-01, ADR 0052): the IF-3 events of the signed-in user over Server-Sent Events on the same origin, and polling as the fallback.
// The page does not trust event contents for state: an event only says "something changed", and the page reloads what it shows from the API (the API decides
// what the caller may see). `stream.resync` and a dropped connection reload too; while the stream is down the page polls.
import { useEffect, useRef } from 'react';

const EVENTS = ['instance.state_changed', 'attempt.state_changed', 'attempt.milestone_reached', 'attempt.flag_captured', 'attempt.hint_unlocked', 'attempt.score_updated', 'stream.resync'];

export function useLive(reload: () => void, { pollMs = 15000, busy = false }: { pollMs?: number; busy?: boolean } = {}): void {
  const latest = useRef(reload);
  latest.current = reload;
  const streamUp = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        latest.current();
      }, 250); // a burst of events is one reload
    };
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      source = new EventSource('/api/v1/live', { withCredentials: true });
      source.onopen = () => {
        streamUp.current = true;
      };
      for (const name of EVENTS) source.addEventListener(name, soon);
      source.onerror = () => {
        streamUp.current = false;
        source?.close();
        soon();
        retry = setTimeout(open, 10000);
      };
    };
    open();
    return () => {
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);

  useEffect(() => {
    // poll faster while something is changing (an instance starting), and always when the stream is down
    const every = busy ? 2000 : pollMs;
    const id = setInterval(() => {
      if (busy || !streamUp.current) latest.current();
    }, every);
    return () => clearInterval(id);
  }, [busy, pollMs]);
}
