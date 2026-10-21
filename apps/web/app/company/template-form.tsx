'use client';

import type { FormEvent } from 'react';
import type { Template } from '../../lib/api';

// The template form of the company page, for a new template and for an edit (FR-ASM-01, R-08, R-09). It sends every field, because the API replaces a template as a
// whole (a field left out goes back to its default). The ranges are the API's (OI-25 placeholders); the API refuses a value outside them and the page shows why.
export const ALL_KEYS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'];

export function TemplateForm({ idp, initial, titles, submitLabel, onSubmit, onCancel }: {
  idp: string;
  initial?: Template;
  titles: Record<string, string>;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const has = (k: string) => (initial ? initial.challenge_keys.includes(k) : false);
  return (
    <form
      aria-label={initial ? `Edit ${initial.title}` : 'New template'}
      onSubmit={async (ev: FormEvent<HTMLFormElement>) => {
        ev.preventDefault();
        const form = ev.currentTarget;
        const f = new FormData(form);
        const hints = f.get('hints') === 'on';
        const ok = await onSubmit({
          title: String(f.get('title') ?? '').trim(),
          challenge_keys: ALL_KEYS.filter((k) => f.get(`key-${k}`) === 'on'),
          time_limit_min: Number(f.get('time_limit_min')),
          hints_mode: hints ? 'on' : 'off',
          ...(hints ? { hint_cost_pct: Number(f.get('hint_cost_pct')) } : {}),
          reset_limit: Number(f.get('reset_limit')),
          invite_expiry_days: Number(f.get('invite_expiry_days')),
          retention_days: Number(f.get('retention_days')),
          flag_submissions_per_minute: Number(f.get('flag_submissions_per_minute')),
          results_visibility: f.get('results') === 'after_release' ? 'after_release' : 'after_submit',
          writeup_required: f.get('writeup') === 'on',
          cohort_board: f.get('cohort_board') === 'on',
        });
        if (ok && !initial) form.reset();
      }}
    >
      <label htmlFor={`${idp}-title`}>Title</label>
      <input id={`${idp}-title`} name="title" type="text" maxLength={120} required defaultValue={initial?.title ?? ''} />
      <fieldset>
        <legend>Challenges</legend>
        <div className="row">
          {ALL_KEYS.map((k) => (
            <label key={k} className="check"><input type="checkbox" name={`key-${k}`} defaultChecked={has(k)} /> <span>{k} {titles[k] ?? ''}</span></label>
          ))}
        </div>
      </fieldset>
      <label htmlFor={`${idp}-time`}>Time limit (minutes, 30 to 480)</label>
      <input id={`${idp}-time`} name="time_limit_min" type="text" inputMode="numeric" defaultValue={String(initial?.time_limit_min ?? 120)} required />
      <label className="check"><input type="checkbox" name="hints" defaultChecked={initial?.hints_mode === 'on'} /> <span>Allow hints</span></label>
      <label htmlFor={`${idp}-hint-cost`}>Cost of each hint (percent of the challenge&apos;s points, 0 to 100)</label>
      <input id={`${idp}-hint-cost`} name="hint_cost_pct" type="text" inputMode="numeric" defaultValue={String(initial && initial.hints_mode === 'on' ? initial.hint_cost_pct : 10)} />
      <label htmlFor={`${idp}-resets`}>Instance resets allowed (0 to 10)</label>
      <input id={`${idp}-resets`} name="reset_limit" type="text" inputMode="numeric" defaultValue={String(initial?.reset_limit ?? 3)} required />
      <label htmlFor={`${idp}-expiry`}>The invitation is valid for (days, 1 to 30)</label>
      <input id={`${idp}-expiry`} name="invite_expiry_days" type="text" inputMode="numeric" defaultValue={String(initial?.invite_expiry_days ?? 7)} required />
      <label htmlFor={`${idp}-retention`}>Keep the candidate&apos;s record for (days, 30 to 365; it is deleted after that)</label>
      <input id={`${idp}-retention`} name="retention_days" type="text" inputMode="numeric" defaultValue={String(initial?.retention_days ?? 180)} required />
      <label htmlFor={`${idp}-flags`}>Flag tries per minute (1 to 60)</label>
      <input id={`${idp}-flags`} name="flag_submissions_per_minute" type="text" inputMode="numeric" defaultValue={String(initial?.flag_submissions_per_minute ?? 10)} required />
      <label className="check"><input type="checkbox" name="writeup" defaultChecked={initial?.writeup_required ?? false} /> <span>Require a write-up</span></label>
      <label className="check"><input type="radio" name="results" value="after_submit" defaultChecked={initial?.results_visibility !== 'after_release'} /> <span>Candidates see their results when they submit</span></label>
      <label className="check"><input type="radio" name="results" value="after_release" defaultChecked={initial?.results_visibility === 'after_release'} /> <span>Candidates see their results when you release them</span></label>
      <label className="check"><input type="checkbox" name="cohort_board" defaultChecked={initial?.cohort_board ?? false} /> <span>Turn on the private cohort view with a ranking aid for this assessment</span></label>
      <p className="row"><button type="submit">{submitLabel}</button>{onCancel && <button type="button" className="ghost" onClick={onCancel}>Cancel</button>}</p>
    </form>
  );
}
