'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, say, type Attempt, type CatalogueItem, type ConsentNotice, type MyInvite } from '../../../lib/api';
import { useRequireUser } from '../../../lib/session';
import { AttemptBoard } from '../../attempt-board';

// A candidate's assessment (FR-DSH-04, FR-HNT-02, FR-PRV-01): the consent notice first (story P-16's routes), then the attempt. Hints appear only when the
// template turned them on, with the cost confirmed before each unlock; results only when the invite's `results_visibility` allows (OI-15). The invite comes
// from the caller's own list, so another person's attempt id shows nothing here (and the lab answers 404 for it).
export default function AssessmentPage() {
  const user = useRequireUser();
  const { attemptId } = useParams<{ attemptId: string }>();
  const [invite, setInvite] = useState<MyInvite | null | undefined>(undefined);
  const [catalog, setCatalog] = useState<CatalogueItem[]>([]);
  const [notice, setNotice] = useState<ConsentNotice | null>(null);
  const [banner, setBanner] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);
  const [agreed, setAgreed] = useState(false); // FR-PRV-01: the agree box is never pre-ticked

  const load = useCallback(async () => {
    try {
      const [mine, c] = await Promise.all([
        api<{ items: MyInvite[] }>('GET', '/api/v1/me/invites'),
        api<{ items: CatalogueItem[] }>('GET', '/api/v1/challenges').catch(() => ({ items: [] as CatalogueItem[] })), // titles only: the page works without them
      ]);
      const found = mine.items.find((i) => i.attempt_id === attemptId) ?? null;
      setInvite(found);
      setCatalog(c.items);
      setNotice(found && found.state === 'opened' ? await api<ConsentNotice>('GET', `/api/v1/consent/notice?attempt_id=${encodeURIComponent(attemptId)}`) : null);
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
    }
  }, [attemptId]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const resultsAllowed = useCallback(
    (a: Attempt) => !!invite && ['submitted', 'reported'].includes(a.state) && (invite.results_visibility === 'after_submit' || a.results_released === true), // IF-2 2.1.0: or once the company released them
    [invite],
  );

  async function decide(decision: 'granted' | 'declined') {
    if (!notice) return;
    setBanner(null);
    try {
      await api('POST', '/api/v1/consent', { attempt_id: notice.attempt_id, notice_version: notice.notice_version, notice_text_sha256: notice.notice_text_sha256, decision });
      setBanner({ text: decision === 'granted' ? 'Thank you. You can start when you are ready.' : 'You declined. The company is told; nothing was recorded about you beyond this answer.', kind: 'ok' });
      await load();
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
      if (e instanceof Error && e.message === 'ATT-CONSENT-STALE') await load();
    }
  }

  async function askDeletion() {
    if (!window.confirm('Ask the company to delete this assessment record? It decides within 14 days; after approval the record is deleted 7 days later.')) return;
    setBanner(null);
    try {
      await api('POST', '/api/v1/me/deletion-requests', { kind: 'candidate', attempt_id: attemptId });
      setBanner({ text: 'Your request was sent to the company. You can follow it on your account page.', kind: 'ok' });
    } catch (e) {
      setBanner({ text: say(e), kind: 'bad' });
    }
  }

  if (!user || invite === undefined) return <p className="muted">Loading...</p>;
  if (invite === null) {
    return (
      <div className="card">
        <h1>Assessment</h1>
        {banner && <p className="banner bad">{banner.text}</p>}
        <p>This assessment is not one of yours. <Link href="/dashboard">Back to your dashboard</Link></p>
      </div>
    );
  }

  return (
    <>
      <h1>{invite.title}</h1>
      <p className="muted">{invite.company_name} · {invite.time_limit_min ? `${invite.time_limit_min} minutes` : ''} · hints {invite.hints_mode === 'on' ? `on (${invite.hint_cost_pct}% each)` : 'off'}</p>
      {banner && <p className={`banner ${banner.kind}`} role={banner.kind === 'bad' ? 'alert' : 'status'}>{banner.text}</p>}
      {notice ? (
        <section className="card" data-testid="consent">
          <h2>Before you start: your data</h2>
          <p className="notice">{notice.notice_text}</p>
          <p className="muted">{notice.company_name} keeps your assessment record for {notice.retention_days_shown} days.</p>
          <label className="check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.currentTarget.checked)} data-testid="consent-agree" />
            <span>I have read this and agree to these terms for this assessment.</span>
          </label>
          <div className="row">
            <button type="button" disabled={!agreed} onClick={() => decide('granted')}>Start</button>
            <button type="button" className="ghost" onClick={() => decide('declined')}>Decline</button>
          </div>
        </section>
      ) : ['consented', 'started'].includes(invite.state) ? (
        <section className="card">
          <AttemptBoard attemptId={attemptId} catalog={catalog} resultsAllowed={resultsAllowed} onChanged={load} />
          <p><button type="button" className="ghost" onClick={askDeletion}>Ask the company to delete this record</button></p>
        </section>
      ) : (
        <p className="card">This invitation is {invite.state}.</p>
      )}
    </>
  );
}
