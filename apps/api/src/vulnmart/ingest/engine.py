"""The milestone engine (story 6.3, D-74): events in, milestones out, driven only by `milestone_rules.json`.

Pure Python over the Protocols of `stores.py`; the ingest worker (Akshay, H-330) calls `process` per verified event and
`tick` at least every 10 seconds. There is no branch on a challenge key here.

Rules of credit: only an event or a platform-verified flag credits; the best milestone per (attempt, challenge) counts once and
survives a reset; M3 needs a flag recomputed by the platform for the instance's CURRENT epoch; events of a bot or an internal
session never count; the same `(instance_id, epoch, seq)` twice changes nothing. Times are the platform's arrival times.
No flag, digest or key goes into a log line, an exception or an explanation text.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from vulnmart.flags.checker import FlagCheck, FlagChecker, FlagClass
from vulnmart.ingest import rules as rules_mod
from vulnmart.ingest.stores import (
    ActivityGate, AllowAllGate, EventLog, InstanceDirectory, InstanceInfo, IntegritySink, MilestoneStore, StoredEvent,
)
from vulnmart.ports.reports import IntegrityType, Milestone

RECENT_WITHIN_S = 7200  # live and recently ended instances that the sharing check looks at
_IGNORED_SESSIONS = frozenset({"bot", "internal"})
_FLAG_EVENT = "proxy.flag_seen"


@dataclass(frozen=True, slots=True)
class Credit:
    attempt_id: str
    challenge_key: str
    milestone: Milestone
    at: datetime


@dataclass(slots=True)
class ProcessResult:
    stored: bool = True  # False: a replay of the same triple, nothing happened
    credits: list[Credit] = field(default_factory=list)
    held: list[str] = field(default_factory=list)  # challenge keys whose M3 waits for a human
    integrity: list[IntegrityType] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class _Pending:
    instance_id: str
    epoch: int
    seq: int
    attempt_id: str
    challenge_key: str
    account: str
    success_at: datetime
    due: datetime
    rule_window_s: int
    absent_type: str
    group_by: str


def is_countable(event: Mapping[str, Any]) -> bool:
    """False for a bot or internal session and for source bot: such events never credit a milestone."""
    return event.get("session_kind") not in _IGNORED_SESSIONS and event.get("source") != "bot"


def recent_others(directory: InstanceDirectory, info: InstanceInfo, challenge_keys: tuple[str, ...]) -> dict[str, int]:
    """Instances (other than this one) of the same template and challenges that the sharing check tries, instance to epoch."""
    others: dict[str, int] = {}
    for c in challenge_keys:
        for iid, epoch in directory.recent(c, info.template_id, RECENT_WITHIN_S).items():
            if iid != info.instance_id:
                others[iid] = max(others.get(iid, 0), epoch)
    return others


def classify_digest(checker: FlagChecker, directory: InstanceDirectory, info: InstanceInfo, *, epoch: int,
                    candidate: str | None = None, candidate_sha256: str | None = None,
                    claimed: str | None = None) -> FlagCheck:
    """Recompute and classify. Own instance first; only when it is wrong are the other instances tried (a bounded loop)."""
    kw = {"instance_id": info.instance_id, "epoch": epoch, "candidate": candidate, "candidate_sha256": candidate_sha256}
    first = checker.classify(challenge_keys=info.challenge_keys, **kw)
    if first.flag_class is not FlagClass.WRONG:
        return first
    keys = (claimed,) if claimed in info.challenge_keys else info.challenge_keys
    others = recent_others(directory, info, keys)
    if not others:
        return first
    return checker.classify(challenge_keys=keys, other_instances=others, **kw)


def apply_check(check: FlagCheck, info: InstanceInfo, *, event_epoch: int, at: datetime, milestones: MilestoneStore,
                integrity: IntegritySink, gate: ActivityGate) -> tuple[str, bool]:
    """Turn a flag check into effects. Returns (credit, new): credit is `credited`, `held` or `none`; `new` says the store
    changed (a milestone rose, a capture was held, or an integrity flag was written)."""
    c = check.challenge_key
    if check.flag_class is FlagClass.CORRECT and c is not None and event_epoch == info.epoch:
        if not gate.allows(info.attempt_id, c, at):
            new = milestones.hold(info.attempt_id, c, at)
            integrity.add(info.attempt_id, IntegrityType.ACTIVITY,
                          "The capture does not match the recorded activity; it is held for review.", f"held:{c}", c, at)
            return "held", new
        new = milestones.credit(info.attempt_id, c, Milestone.M3, at)
        return "credited", new
    if check.flag_class is FlagClass.DECOY and c is not None:
        new = integrity.add(info.attempt_id, IntegrityType.DECOY,
                            f"A decoy value of challenge {c} was used on instance {info.instance_id}.", f"decoy:{c}", c, at)
        return "none", new
    if check.flag_class is FlagClass.OTHER_INSTANCE and c is not None and check.other_instance_id:
        new = integrity.add(
            info.attempt_id, IntegrityType.SHARING,
            f"A value of challenge {c} that belongs to instance {check.other_instance_id} was used on instance {info.instance_id}.",
            f"sharing:{check.other_instance_id}", c, at)
        return "none", new
    return "none", False


class MilestoneEngine:
    def __init__(self, *, log: EventLog, milestones: MilestoneStore, integrity: IntegritySink, directory: InstanceDirectory,
                 checker: FlagChecker, gate: ActivityGate | None = None, rules: Mapping[str, Any] | None = None,
                 is_open: Callable[[str, datetime], bool] | None = None) -> None:
        self.log, self.milestones, self.integrity = log, milestones, integrity
        self.directory, self.checker = directory, checker
        self.gate: ActivityGate = gate or AllowAllGate()
        self.rules: Mapping[str, Any] = rules if rules is not None else rules_mod.load_rules()
        self._types = {(ck, m): rules_mod.rule_types(r) for ck, ms in self.rules["challenges"].items() for m, r in ms.items()}
        # `is_open(attempt_id, at)`: was the attempt running at `at` (not yet over, before its deadline)? Events after that are stored but never credit (audit B5).
        self._is_open = is_open or (lambda attempt_id, at: True)
        self._pending: dict[tuple[str, int, int, str], _Pending] = {}  # in memory; `recover` rebuilds it from the stored events after a restart

    # ---- public ----

    def process(self, event: Mapping[str, Any], received_at: datetime) -> ProcessResult:
        """One verified event. Unknown types and unknown instances have no effect; a replay is a no-op."""
        if not self.log.append(event, received_at):
            return ProcessResult(stored=False)
        res = ProcessResult()
        info = self.directory.get(event["instance_id"])
        if info is None or not is_countable(event):
            return res
        if not self._is_open(info.attempt_id, received_at):
            return res  # the attempt is over (submitted, expired, cancelled, withdrawn or past its deadline): the event is kept, it credits nothing
        if event["type"] == _FLAG_EVENT:
            self._flag_event(event, info, received_at, res)
            return res
        rows = [r for r in self.log.read(info.instance_id, event["epoch"])]
        cur = next(r for r in rows if r.event["seq"] == event["seq"])
        for ck in info.challenge_keys:
            if ck not in self.rules["challenges"]:
                continue
            for m, milestone in (("m2", Milestone.M2), ("m1", Milestone.M1)):
                if event["type"] not in self._types[(ck, m)]:
                    continue
                if self._eval(self.rules["challenges"][ck][m], info, ck, cur, rows):
                    if self.milestones.credit(info.attempt_id, ck, milestone, received_at):
                        res.credits.append(Credit(info.attempt_id, ck, milestone, received_at))
                    break
        res.credits += self._settle_zero_grace(received_at)
        return res

    def recover(self, infos: Iterable[InstanceInfo]) -> int:
        """Rebuild the open negative-observation windows (C09 M2) of the given instances from the stored events, after a restart (audit B5: the windows
        lived only in memory and a replayed event is a no-op). Deterministic and safe to repeat: a window already settled is evaluated again to the same
        answer and a credit is only ever raised once. Returns the number of windows now pending."""
        for info in infos:
            rows = [r for r in self.log.read(info.instance_id, info.epoch) if is_countable(r.event)]
            for cur in rows:
                if not self._is_open(info.attempt_id, cur.received_at):
                    continue
                for ck in info.challenge_keys:
                    for m, milestone in (("m2", Milestone.M2), ("m1", Milestone.M1)):
                        rule = self.rules["challenges"].get(ck, {}).get(m)
                        if rule is None or cur.event["type"] not in self._types[(ck, m)]:
                            continue
                        # a negative window is only opened here (`tick` settles it); another rule that holds also makes good a credit the crash lost
                        if self._eval(rule, info, ck, cur, rows):
                            self.milestones.credit(info.attempt_id, ck, milestone, cur.received_at)
                            break
        return len(self._pending)

    def tick(self, now: datetime) -> list[Credit]:
        """Finalise the negative-observation windows whose grace period is over. Call at least every 10 seconds."""
        out: list[Credit] = []
        for key, p in sorted(self._pending.items(), key=lambda kv: kv[1].due):
            if p.due > now:
                continue
            del self._pending[key]
            if not self._is_open(p.attempt_id, p.success_at):
                continue  # the success happened after the attempt ended
            rows = self.log.read(p.instance_id, p.epoch)
            start = p.success_at - timedelta(seconds=p.rule_window_s)
            logged = any(r.event["type"] == p.absent_type and rules_mod.field_value(r.event, p.group_by) == p.account
                         and start <= r.received_at <= p.due for r in rows)
            if logged:
                continue
            if self.milestones.credit(p.attempt_id, p.challenge_key, Milestone.M2, p.due):
                out.append(Credit(p.attempt_id, p.challenge_key, Milestone.M2, p.due))
        return out

    # ---- flags ----

    def _flag_event(self, event: Mapping[str, Any], info: InstanceInfo, at: datetime, res: ProcessResult) -> None:
        d = event["data"]
        # the sidecar's `kind` is only a hint; the platform recomputes (FR-FLG-04)
        check = classify_digest(self.checker, self.directory, info, epoch=event["epoch"],
                                candidate_sha256=d["candidate_sha256"], claimed=d.get("challenge_key"))
        credit, new = apply_check(check, info, event_epoch=event["epoch"], at=at, milestones=self.milestones,
                                  integrity=self.integrity, gate=self.gate)
        if not new:
            return
        if credit == "credited" and check.challenge_key:
            res.credits.append(Credit(info.attempt_id, check.challenge_key, Milestone.M3, at))
        elif credit == "held" and check.challenge_key:
            res.held.append(check.challenge_key)
        elif check.flag_class is FlagClass.DECOY:
            res.integrity.append(IntegrityType.DECOY)
        elif check.flag_class is FlagClass.OTHER_INSTANCE:
            res.integrity.append(IntegrityType.SHARING)

    # ---- rule evaluation ----

    def _eval(self, rule: Mapping[str, Any], info: InstanceInfo, ck: str, cur: StoredEvent, rows: list[StoredEvent]) -> bool:
        kind = rule["kind"]
        ev = cur.event
        if kind == "any":
            return any(self._eval(sub, info, ck, cur, rows) for sub in rule["of"])
        if kind == "event":
            return ev["type"] == rule["type"] and rules_mod.match_where(rule.get("where", {}), ev)
        if kind == "flag":
            return False  # M3 comes only through a verified flag
        if kind == "negative_window":
            self._open_window(rule, info, ck, cur, rows)
            return False  # credited by tick when the grace period is over
        countable = [r for r in rows if is_countable(r.event)]
        if kind == "count_distinct":
            vals = {rules_mod.field_value(r.event, rule["field"]) for r in countable
                    if r.event["type"] == rule["type"] and rules_mod.match_where(rule.get("where", {}), r.event)}
            vals.discard(None)
            return len(vals) >= rule["at_least"]
        # count (optionally grouped, summed, or followed by a `then` event)
        pool = countable
        if "then" in rule:
            then = rule["then"]
            if ev["type"] != then["type"] or not rules_mod.match_where(then.get("where", {}), ev):
                return False
            pool = [r for r in countable if r.order < cur.order]
        hits = [r for r in pool if r.event["type"] == rule["type"] and rules_mod.match_where(rule.get("where", {}), r.event)]
        if "sum_field" in rule:
            total = sum(v for r in hits if type(v := rules_mod.field_value(r.event, rule["sum_field"])) is int)
            return total >= rule["at_least"]
        if "group_by" in rule:
            groups: dict[Any, int] = {}
            for r in hits:
                g = rules_mod.field_value(r.event, rule["group_by"])
                groups[g] = groups.get(g, 0) + 1
            return max(groups.values(), default=0) >= rule["at_least"]
        return len(hits) >= rule["at_least"]

    def _open_window(self, rule: Mapping[str, Any], info: InstanceInfo, ck: str, cur: StoredEvent, rows: list[StoredEvent]) -> None:
        ev, succ, fail = cur.event, rule["success"], rule["failures"]
        if ev["type"] != succ["type"] or not rules_mod.match_where(succ.get("where", {}), ev):
            return
        group = rule["group_by"]
        account = rules_mod.field_value(ev, group)
        if account is None:
            return
        start = cur.received_at - timedelta(seconds=rule["window_s"])
        n = sum(1 for r in rows if is_countable(r.event) and r.event["type"] == fail["type"] and r.order < cur.order
                and rules_mod.field_value(r.event, group) == account and rules_mod.match_where(fail.get("where", {}), r.event)
                and start <= r.received_at <= cur.received_at)
        if n < fail["at_least"]:
            return
        key = (info.instance_id, ev["epoch"], ev["seq"], ck)
        self._pending.setdefault(key, _Pending(
            info.instance_id, ev["epoch"], ev["seq"], info.attempt_id, ck, str(account), cur.received_at,
            cur.received_at + timedelta(seconds=rule["grace_s"]), rule["window_s"], rule["absent"]["type"], group))

    def _settle_zero_grace(self, now: datetime) -> list[Credit]:
        return self.tick(now) if any(p.due <= now for p in self._pending.values()) else []
