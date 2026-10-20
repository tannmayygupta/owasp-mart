"""Data exports (story P-29, FR-EXP-01 to 04, OI-27 answered by the developer on 2026-10-20: a recruiter exports scores as CSV and JSON, no evidence).

`own_zip` is a person's own data, the same for a candidate and a learner (FR-EXP-01, 02): the profile, the consent history, every attempt of theirs with its results,
timings, hints and evidence requests, who viewed their data, and their deletion requests, as JSON and CSV in one zip. `company_zip` is one assessment template's
results for the recruiter's company (FR-EXP-03): per candidate the invite and attempt state, the score of 1000, the per-challenge points, time to capture, active
time, hints used and open integrity flags; no evidence. Each export writes an audit entry (FR-EXP-04), and the company export records "exported" in each candidate's
view history (FR-PRV-11).

No flag value leaves the platform: the evidence requests are passed through `redact`, which replaces anything shaped like a flag (`VM{...}`); the export never
reads the flag material. CSV cells that a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, carriage return) are prefixed with a quote. The lab's data is
read from the lab runtime of this process (read only); without one, the attempts part says so and is empty.
"""
from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.models import User
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.scope import Scope

FLAG_SHAPE = re.compile(r"VM\{[^}\s]{0,256}\}?", re.IGNORECASE)
FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
MAX_EVIDENCE_BODY = 8192
README_OWN = """Your VulnMart data (story P-29, FR-EXP-01, FR-EXP-02)

profile.json            your account
consents.json/.csv      every consent you gave, declined or withdrew
attempts.json           your attempts: state, times, score, per challenge results, hints, evidence requests
attempts.csv            one row per attempt and challenge
data_views.json/.csv    which companies viewed or exported your data (company, action, time)
deletion_requests.json  your deletion requests

Flag values are never included: anything shaped like a flag in a captured request is replaced by VM{redacted}.
"""
README_COMPANY = """VulnMart assessment results (story P-29, FR-EXP-03)

results.csv   one row per candidate: invite and attempt state, score of 1000, times, hints used, open integrity flags, points per challenge
results.json  the same, with the per-challenge details

Evidence (captured requests) is not included (OI-27). This export is recorded in the audit log and in each candidate's view history.
"""


def redact(text: str | None) -> str | None:
    return None if text is None else FLAG_SHAPE.sub("VM{redacted}", text)


def cell(value: Any) -> str:
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(FORMULA_START) else text


def stamp(moment: datetime | None) -> str | None:
    if moment is None:
        return None
    moment = moment if moment.tzinfo else moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def csv_text(header: list[str], rows: list[list[Any]]) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(header)
    for row in rows:
        writer.writerow([cell(v) for v in row])
    return out.getvalue()


def zip_bytes(files: dict[str, str], when: datetime) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=when.astimezone(UTC).timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[name])
    return buf.getvalue()


def dumps(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def attempt_results(rt: Any, rec: Any, now: datetime, *, evidence: bool) -> dict[str, Any]:
    """One attempt's results read from the lab runtime (read only): score, per challenge, times, hints and, with `evidence`, the captured requests with
    anything shaped like a flag redacted. Used by the exports and by break-glass (story P-31)."""
    total, rows = rt.score_rows(rec.id)
    metrics = rt.time_metrics(rec.id)
    end = rec.submitted_at or now
    elapsed = max(0, int((end - rec.started_at).total_seconds())) if rec.started_at else None
    per = [{"challenge_key": r["challenge_key"], "best_milestone": r["best_milestone"], "points": r["points"], "held": r["held"],
            "hints_used": r["hints_used"], "time_to_capture_seconds": metrics.headline.get(r["challenge_key"])} for r in rows]
    out: dict[str, Any] = {"attempt_id": rec.id, "mode": "candidate" if getattr(rec, "org_id", None) else "learner", "state": rec.state.value,
                           "created_at": stamp(rec.created_at), "started_at": stamp(rec.started_at), "submitted_at": stamp(rec.submitted_at),
                           "score": total, "elapsed_seconds": elapsed, "active_seconds": metrics.active_seconds if rec.started_at else None,
                           "hints_used_total": sum(r["hints_used"] for r in rows), "per_challenge": per}
    if evidence:
        items = []
        for item in rt.reports.evidence(rec.id):
            text = rt.reports.evidence_body(rec.id, item.evidence_id).decode("utf-8", "replace")
            head, _, rest = text.partition("\n")
            parts = head.split(" ")
            body = rest[1:] if rest.startswith("\n") else rest
            items.append({"challenge_key": item.challenge_key, "captured_at": stamp(item.captured_at), "method": parts[0] if parts else "GET",
                          "path": redact(parts[1] if len(parts) > 1 else "/"), "body": redact(body[:MAX_EVIDENCE_BODY]) if body else None})
        out["evidence"] = items
    return out


class ExportService:
    def __init__(self, *, sessions: sessionmaker[Session], audit: AuditPort, consent: Any, views: Any, deletion: Any, assessments: Any, companies: Any,
                 lab: Callable[[], Any | None], now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._sessions, self._audit, self._consent, self._views, self._deletion = sessions, audit, consent, views, deletion
        self._assessments, self._companies, self._lab, self._now = assessments, companies, lab, now

    # ---- a person's own data (FR-EXP-01, 02) ----

    def own_zip(self, user_id: str) -> tuple[bytes, int]:
        """The zip and how many attempts it holds. Audited as `export.own`."""
        now = self._now()
        with self._sessions() as session:
            user = session.scalar(select(User).where(User.id == user_id))
            if user is None:
                raise LookupError(user_id)
            profile = {"user_id": user.id, "email": user.email, "display_name": user.display_name, "account_type": user.account_type,
                       "created_at": stamp(user.created_at), "email_verified": user.email_verified_at is not None, "exported_at": stamp(now)}
        consents = self._consent.list_mine(user_id, 1000)[0] if self._consent is not None else []
        consent_rows = [{"attempt_id": c.attempt_id, "decision": c.decision, "notice_version": c.notice_version, "recorded_at": stamp(c.recorded_at)} for c in consents]
        views = self._views.list_mine(user_id, 1000)[0] if self._views is not None else []
        view_rows = [{"company_name": v.company_name, "action": v.action, "at": stamp(v.at)} for v in views]
        requests = self._deletion.mine(user_id, 100) if self._deletion is not None else []
        request_rows = [{"kind": r.kind, "status": r.status, "requested_at": stamp(r.requested_at), "company_name": r.company_name, "attempt_id": r.attempt_id,
                         "execute_after": stamp(r.execute_after)} for r in requests]
        rt = self._lab()
        attempts: list[dict[str, Any]] = []
        note = None
        if rt is None:
            note = "The lab is not running in this process, so no attempt is included."
        else:
            for rec in rt.engine.for_user(user_id):
                if getattr(rec, "purged_at", None) is None and rec.state.value != "deleted":
                    attempts.append(attempt_results(rt, rec, self._now(), evidence=True))
        attempt_rows = [[a["attempt_id"], a["mode"], a["state"], a["score"], c["challenge_key"], c["best_milestone"], c["points"], c["hints_used"],
                         c["time_to_capture_seconds"]] for a in attempts for c in a["per_challenge"]]
        files = {
            "README.txt": README_OWN,
            "profile.json": dumps(profile),
            "consents.json": dumps(consent_rows),
            "consents.csv": csv_text(["attempt_id", "decision", "notice_version", "recorded_at"], [list(r.values()) for r in consent_rows]),
            "attempts.json": dumps({"attempts": attempts, "note": note}),
            "attempts.csv": csv_text(["attempt_id", "mode", "state", "score", "challenge_key", "best_milestone", "points", "hints_used", "time_to_capture_seconds"],
                                     attempt_rows),
            "data_views.json": dumps(view_rows),
            "data_views.csv": csv_text(["company_name", "action", "at"], [list(r.values()) for r in view_rows]),
            "deletion_requests.json": dumps(request_rows),
        }
        data = zip_bytes(files, now)
        self._audit.append(actor=user_id, action="export.own", subject=user_id, details={"attempts": len(attempts)})
        return data, len(attempts)

    # ---- a company's results of one template (FR-EXP-03) ----

    def company_zip(self, actor: Scope, template_id: str) -> tuple[bytes, int]:
        """The zip and how many candidates it holds. The template must be the actor's company's (the assessment service checks it: TemplateNotFound otherwise).
        Audited as `export.company`; every candidate in it gets an `exported` entry in their view history."""
        now = self._now()
        template = self._assessments.get_template(actor, template_id)
        invites = self._assessments.list_invites(actor, template_id=template.template_id, limit=100)
        rt = self._lab()
        rows: list[dict[str, Any]] = []
        for invite in invites:
            result = None
            if rt is not None and invite.attempt_id:
                try:
                    rec = rt.engine.get(invite.attempt_id)
                except Exception:  # noqa: BLE001 - an attempt the lab no longer has is exported without results
                    rec = None
                if rec is not None and str(getattr(rec, "org_id", "") or "") == str(actor.org_id) and getattr(rec, "purged_at", None) is None:
                    result = attempt_results(rt, rec, self._now(), evidence=False)
            rows.append({"email": invite.email, "invite_state": invite.state, "invite_id": invite.invite_id, "attempt_id": invite.attempt_id,
                         "generation": invite.generation, "results": result})
        keys = list(template.challenge_keys)
        header = ["email", "invite_state", "attempt_state", "score", "elapsed_seconds", "active_seconds", "hints_used_total", "integrity_open",
                  *[f"points_{k}" for k in keys]]
        csv_rows = []
        for r in rows:
            res = r["results"] or {}
            per = {c["challenge_key"]: c["points"] for c in res.get("per_challenge", [])}
            open_flags = None
            if rt is not None and r["attempt_id"] and res:
                open_flags = sum(1 for f in rt.integrity.of(r["attempt_id"]) if f.status == "open")
            csv_rows.append([r["email"], r["invite_state"], res.get("state"), res.get("score"), res.get("elapsed_seconds"), res.get("active_seconds"),
                             res.get("hints_used_total"), open_flags, *[per.get(k) for k in keys]])
        files = {
            "README.txt": README_COMPANY,
            "results.csv": csv_text(header, csv_rows),
            "results.json": dumps({"template": {"template_id": template.template_id, "title": template.title, "challenge_keys": keys,
                                                "hints_mode": template.hints_mode, "hint_cost_pct": template.hint_cost_pct, "version": template.version},
                                   "exported_at": stamp(now), "candidates": rows,
                                   "note": None if rt is not None else "The lab is not running in this process, so no results are included."}),
        }
        data = zip_bytes(files, now)
        self._audit.append(actor=actor.user_id, action="export.company", subject=None,
                           details={"org": str(actor.org_id), "template": template.template_id, "candidates": len(rows)})
        if self._views is not None:
            name = self._company_name(actor)
            for invite in invites:
                if invite.user_id:
                    self._views.record(candidate_user_id=invite.user_id, org_id=str(actor.org_id), org_name=name, action="exported")
        return data, len(rows)

    def _company_name(self, actor: Scope) -> str:
        name = self._companies.company_name_of(actor.user_id, str(actor.org_id)) if self._companies is not None else None
        return name or "a company"
