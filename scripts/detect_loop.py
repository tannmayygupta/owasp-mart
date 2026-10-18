"""Local detection loop (story 6.4, task L-21 part 2). LOCAL: Docker Desktop on a developer PC, stub shop and stub injector, the real
sidecar image, a fake ingest standing in for the edge relay. It proves the chain from a planted flag to a milestone; it proves nothing
about the live `vm-i` host (that is `docs/runbooks/detection-live-check.md`).

Run from the repository root:

    uv run --locked --package vulnmart-orchestrator python scripts/detect_loop.py

What it does: derives flag material (story 6.1), creates two instances of one template with the real orchestrator engine (injector, stub
shop, product sidecar), starts a fake ingest that answers as `edge` and a tiny reflector in front of the shop on each instance network,
sends requests through the sidecar's player port with `docker exec` (the planted flag, a decoy value, a flag of the other instance),
reads the stored signed events back from the fake ingest (`/_fake/events/full`), replays them through the milestone engine (story 6.3),
the evidence recorder, the activity recorder and the bot recorder (this story), pastes a flag, then removes everything it made.

Everything it creates is labelled: containers `vm.loop=detect-loop`, instances by the id prefix `i-DETECTLP`. A run first removes the
leftovers of an earlier crashed run, so it can be started again at any time. The output has no flag, key or digest; at the end the loop
scans its own output and the logs of its containers with `scripts/scan-flags.mjs`. Exit code 0 when every step passes (or Docker is not
available: SKIP), 1 otherwise. Fake keys only (the fake KeyPort), nothing real.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT / "apps" / "api" / "src", ROOT / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

STUB_TAG = "vulnmart-stub-instance:local"
SIDECAR_TAG = "vulnmart-sidecar:local"
LOOP_LABEL = "vm.loop=detect-loop"
IID_PREFIX = "i-DETECTLP"
TEMPLATE_FILE = ROOT / "contracts" / "instance" / "examples" / "valid" / "instance-template" / "shop-template.json"
CHALLENGES = ("C05", "C02")
M3_BUDGET_S = 10.0

REFLECTOR_JS = (  # no double quotes: the argument goes through the Windows command line unchanged
    "const http=require('http');"
    "http.createServer((q,s)=>{const u=new URL(q.url,'http://x');"
    "if(u.pathname==='/reflect'){s.writeHead(200,{'content-type':'text/plain'});return s.end('value='+(u.searchParams.get('v')||''));}"
    "const p=http.request({host:'shop',port:3000,path:q.url,method:q.method,headers:{}},r=>{"
    "s.writeHead(r.statusCode,{'content-type':r.headers['content-type']||'text/plain'});r.pipe(s)});"
    "p.on('error',()=>{s.writeHead(502);s.end()});q.pipe(p)}).listen(3001,'0.0.0.0')"
)
PLAYER_JS = (
    "fetch('http://127.0.0.1:8080'+process.argv[1]).then(async r=>{const b=Buffer.from(await r.arrayBuffer());let t=b;"
    "try{const f=JSON.parse(b.toString()).flag;if(typeof f==='string')t=Buffer.from(f)}catch{}"  # the digest of the flag field when the answer has one
    "console.log(r.status,require('crypto').createHash('sha256').update(t).digest('hex'))})"
    ".catch(()=>{console.log('0 none');process.exit(1)})"
)
SIDECAR_HEALTH = ("CMD", "/nodejs/bin/node", "-e",
                  "fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")

OUT: list[str] = []
FAILED: list[str] = []


def say(line: str) -> None:
    OUT.append(line)
    print(line, flush=True)


def check(name: str, ok: bool, detail: str) -> bool:
    say(f"{'PASS' if ok else 'FAIL'} {name} - {detail}")
    if not ok:
        FAILED.append(name)
    return bool(ok)


def docker(*args: str, timeout: int = 120, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, input=stdin)


def docker_ok() -> bool:
    try:
        return docker("info", "--format", "{{.ServerVersion}}", timeout=30).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def build_images() -> tuple[str, str]:
    """Build both images every run: the layer cache makes it fast, and the stub image carries the fake ingest of this checkout."""
    for tag, args in ((STUB_TAG, ["-f", "contracts/mocks/stub-instance/Dockerfile", "-t", STUB_TAG, "."]),
                      (SIDECAR_TAG, ["-f", "services/sidecar/Dockerfile", "-t", SIDECAR_TAG, "services/sidecar"])):
        r = subprocess.run(["docker", "build", "-q", *args], cwd=ROOT, capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise RuntimeError(f"docker build of {tag} failed: {r.stderr.strip()[-300:]}")
    ids = []
    for tag in (STUB_TAG, SIDECAR_TAG):
        ids.append(docker("image", "inspect", "--format", "{{.Id}}", tag).stdout.strip())
    return ids[0], ids[1]


def my_leftovers() -> dict[str, int]:
    """Objects of this loop: anything with the loop label, and instance objects whose id starts with the loop prefix."""
    out = {"loop containers": 0, "instance containers": 0, "instance networks": 0, "instance volumes": 0}
    out["loop containers"] = len(docker("ps", "-a", "-q", "--filter", f"label={LOOP_LABEL}").stdout.split())
    for key, cmd in (("instance containers", ["ps", "-a"]), ("instance networks", ["network", "ls"]), ("instance volumes", ["volume", "ls"])):
        r = docker(*cmd, "--filter", "label=vm.instance", "--format", '{{.Label "vm.instance"}}')
        out[key] = sum(1 for x in r.stdout.split() if x.startswith(IID_PREFIX))
    return out


def new_iid() -> str:
    return IID_PREFIX + "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(8))


def instance_ids_in_docker() -> set[str]:
    ids: set[str] = set()
    for cmd in (["ps", "-a"], ["network", "ls"], ["volume", "ls"]):
        r = docker(*cmd, "--filter", "label=vm.instance", "--format", '{{.Label "vm.instance"}}')
        ids |= {x for x in r.stdout.split() if x.startswith(IID_PREFIX)}
    return ids


def cid_of(iid: str, component: str) -> str | None:
    r = docker("ps", "-q", "--filter", f"label=vm.instance={iid}", "--filter", f"label=vm.component={component}")
    ids = r.stdout.split()
    return ids[0] if ids else None


def network_of(iid: str) -> str:
    return docker("network", "ls", "--filter", f"label=vm.instance={iid}", "--format", "{{.Name}}").stdout.split()[0]


def run_helper(name: str, net: str, alias: str, image_args: list[str], *, stdin_text: str | None = None) -> subprocess.Popen | None:
    """One loop-owned container on the instance network: read-only, non-root, no capabilities, labelled."""
    argv = ["docker", "run", "--name", name, "--network", net, "--network-alias", alias, "--label", LOOP_LABEL, "--read-only",
            "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "64",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=8m"]
    if stdin_text is not None:
        argv += ["-i"]
    else:
        argv += ["-d"]
    argv += image_args
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, text=True)
    if stdin_text is not None:
        proc.stdin.write(stdin_text)
        proc.stdin.close()
    return proc


def wait_exec_ok(cid: str, argv: list[str], tries: int = 60) -> bool:
    for _ in range(tries):
        if docker("exec", cid, *argv, timeout=20).returncode == 0:
            return True
        time.sleep(0.5)
    return False


def player_get(sidecar: str, path: str) -> tuple[int, str]:
    """A request through the sidecar's player port, made inside the sidecar container. Returns (status, sha256 of the `flag` field of a
    JSON answer, else of the whole body); the answer itself never leaves the container."""
    r = docker("exec", sidecar, "/nodejs/bin/node", "-e", PLAYER_JS, path, timeout=30)
    parts = r.stdout.split()
    return (int(parts[0]), parts[1]) if len(parts) == 2 and parts[0].isdigit() else (0, "none")


def stored_events(ingest_cid: str) -> list[dict]:
    r = docker("exec", ingest_cid, "wget", "-q", "-O", "-", "http://127.0.0.1:8081/_fake/events/full", timeout=30)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return []


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def parse_time(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)


def main() -> int:
    if not docker_ok():
        say("SKIP detect_loop - no Docker daemon is available (this loop needs Docker Desktop); nothing was created")
        return 0
    try:
        import docker as docker_sdk

        sdk = docker_sdk.from_env()
        sdk.ping()
    except Exception:  # the python client is only in the orchestrator environment
        say("SKIP detect_loop - the Docker python client or the daemon is not usable; run it with `uv run --locked --package vulnmart-orchestrator`")
        return 0

    from vulnmart.flags.checker import FlagChecker
    from vulnmart.flags.material import build_material
    from vulnmart.flags.submit import FlagSubmitService
    from vulnmart.ingest.activity import ActivityRecorder, InMemoryActivityStore
    from vulnmart.ingest.bots import BotRecorder, InMemoryBotVisitStore
    from vulnmart.ingest.engine import MilestoneEngine
    from vulnmart.ingest.evidence import EvidenceReader, EvidenceRecorder, InMemoryEvidenceStore
    from vulnmart.ingest.stores import (
        InMemoryEventLog, InMemoryFlagSubmissionLog, InMemoryInstanceDirectory, InMemoryIntegritySink, InMemoryMilestoneStore,
        InstanceInfo,
    )
    from vulnmart.ports.attempts import AttemptState
    from vulnmart.ports.fakes import FakeKeyPort
    from vulnmart.ports.lab_fakes import FakeAttemptPort
    from vulnmart.ports.reports import IntegrityType
    from vulnmart_orchestrator.backend import SdkBackend
    from vulnmart_orchestrator.builder import parse_create, sidecar_document
    from vulnmart_orchestrator.engine import Orchestrator
    from vulnmart_orchestrator.images import ImageAllowlist

    say("detect_loop: LOCAL run on Docker Desktop (stub shop and injector, real sidecar image, fake ingest as edge); not a live result")
    t_start = time.monotonic()
    work = Path(tempfile.mkdtemp(prefix="vm-detect-loop-"))
    orch: Orchestrator | None = None
    iids: list[str] = []
    try:
        stub_id, sidecar_id = build_images()
        check("images-built", True, "stub instance image and product sidecar image built (local tags)")

        template = json.loads(TEMPLATE_FILE.read_text(encoding="utf-8"))
        template["components"] = [c for c in template["components"] if c["role"] in ("injector", "shop", "sidecar")]
        allow = ImageAllowlist(
            {"shop": stub_id, "injector": stub_id, "sidecar": sidecar_id, "volume-keeper": stub_id},
            entrypoints={"volume-keeper": ("node", "-e", "setInterval(()=>{},1<<30)")},
            commands={"shop": ("shop",), "injector": ("inject",),
                      "sidecar": ("/app/src/main.mjs", "--relay", "http://edge:8081/internal/v1/events", "--upstream", "http://reflector:3001")},
            healthchecks={"sidecar": SIDECAR_HEALTH}, allow_local_ids=True)
        orch = Orchestrator(SdkBackend(sdk), {"shop-v0": template}, allow, health_timeout_s=90, injector_timeout_s=60)

        # leftovers of an earlier crashed run
        old = instance_ids_in_docker()
        for c in docker("ps", "-a", "-q", "--filter", f"label={LOOP_LABEL}").stdout.split():
            docker("rm", "-f", c)
        for iid in sorted(old):
            orch.destroy(iid)
        check("started-clean", not any(my_leftovers().values()), f"removed {len(old)} old instance(s) of an earlier run; none left")

        keys = FakeKeyPort()
        iid1, iid2 = new_iid(), new_iid()
        iids += [iid1, iid2]
        attempt1, attempt2 = "a-loop-1", "a-loop-2"

        def body(iid: str) -> dict:
            material = build_material(keys, iid, 1, CHALLENGES, decoys_per_challenge=1)
            return {"instance_id": iid, "template_id": "shop-v0", "epoch": 1, "owner_hash": sha("loop-owner-" + iid),
                    "hostname": f"{iid.lower()}.instances.example.invalid",
                    "limits": {"memory_mb": 256, "cpu_limit": 1.5, "pids_limit": 512, "idle_minutes": 30, "max_minutes": 120},
                    **material.to_json()}

        b1, b2 = body(iid1), body(iid2)
        t0 = time.monotonic()
        r1 = orch.create(b1)
        r2 = orch.create(b2)
        ready = r1.state.value == "ready" and r2.state.value == "ready"
        check("create-two-instances-ready", ready,
              f"states {r1.state.value} and {r2.state.value} after {time.monotonic() - t0:.1f}s (error codes {r1.error_code or 'none'}, {r2.error_code or 'none'}); "
              f"material of story 1: {len(CHALLENGES)} challenges, 1 decoy each")
        if not ready:
            raise RuntimeError("an instance did not reach ready")

        net1 = network_of(iid1)
        ingest_name, reflector_name = f"vm-loop-ingest-{iid1.lower()}", f"vm-loop-reflector-{iid1.lower()}"
        start_doc = sidecar_document(parse_create(b1)).decode()
        run_helper(ingest_name, net1, "edge", [STUB_TAG, "ingest"], stdin_text=start_doc)
        run_helper(reflector_name, net1, "reflector", ["--entrypoint", "node", STUB_TAG, "-e", REFLECTOR_JS])
        ingest_up = wait_exec_ok(ingest_name, ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/_fake/events/full"])
        refl_up = wait_exec_ok(reflector_name, ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3001/reflect?v=x"])
        check("edge-and-reflector-attached", ingest_up and refl_up,
              f"fake ingest (alias edge) up {ingest_up}, reflector in front of the shop up {refl_up}, both on the instance network")
        if not (ingest_up and refl_up):
            raise RuntimeError("helper containers did not start")

        # ---- the engine side (stories 6.3 and 6.4), replayed from the stored events ----
        directory = InMemoryInstanceDirectory()
        directory.add(InstanceInfo(iid1, attempt1, "shop-v0", 1, CHALLENGES))
        directory.add(InstanceInfo(iid2, attempt2, "shop-v0", 1, CHALLENGES))
        log, milestones, integrity = InMemoryEventLog(), InMemoryMilestoneStore(), InMemoryIntegritySink()
        checker = FlagChecker(keys, decoys_per_challenge=1)
        engine = MilestoneEngine(log=log, milestones=milestones, integrity=integrity, directory=directory, checker=checker)
        keys.create_attempt_key(attempt1)
        keys.create_attempt_key(attempt2)
        evidence_store = InMemoryEvidenceStore()
        evidence = EvidenceRecorder(keys=keys, store=evidence_store, directory=directory, checker=checker, milestones=milestones,
                                    integrity=integrity)
        reader = EvidenceReader(store=evidence_store, keys=keys)
        activity = ActivityRecorder(InMemoryActivityStore())
        bots = BotRecorder(InMemoryBotVisitStore())
        fed: set[tuple[int, int]] = set()

        def pump() -> list[dict]:
            events = []
            for row in stored_events(ingest_name):
                ev = row["event"]
                if (ev["epoch"], ev["seq"]) in fed:
                    continue
                fed.add((ev["epoch"], ev["seq"]))
                at = parse_time(row["received_at"])
                res = engine.process(ev, at)
                evidence.observe(ev, at, res)
                activity.observe(ev, at)
                bots.observe(ev, at)
                events.append(ev)
            return events

        sidecar1 = cid_of(iid1, "sidecar")
        shop1, shop2 = cid_of(iid1, "shop"), cid_of(iid2, "shop")

        # 1. the planted flag goes through the sidecar
        status, got = player_get(sidecar1, "/_stub/planted-flag?key=C05")
        t_req = time.monotonic()
        check("planted-flag-through-sidecar", status == 200, f"player request through the sidecar answered HTTP {status}")
        seen: list[dict] = []
        while time.monotonic() - t_req < 30 and not any(e["type"] == "proxy.flag_seen" and e["data"]["kind"] == "real" for e in seen):
            seen += pump()
            time.sleep(0.25)
        credited_after = time.monotonic() - t_req
        has_real = any(e["type"] == "proxy.flag_seen" and e["data"]["kind"] == "real" for e in seen)
        check("signed-event-stored", has_real, f"a signed proxy.flag_seen (real) is in the fake ingest and was accepted by the engine after {credited_after:.2f}s")
        check("m3-credited-in-budget", milestones.best(attempt1, "C05").value == "M3" and credited_after < M3_BUDGET_S,
              f"C05 milestone {milestones.best(attempt1, 'C05').value} {credited_after:.2f}s after the request (budget {M3_BUDGET_S:.0f}s, LOCAL timing only); "
              f"C02 {milestones.best(attempt1, 'C02').value}")
        planted_ok = got == sha(keys.flag(iid1, "C05", 1))
        check("planted-flag-is-the-derived-flag", planted_ok, "the answer of the shop matches the flag the key service derives for this instance and epoch")

        # 2. evidence sealed through KeyPort and read back
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not evidence_store.rows(attempt1):
            pump()
            time.sleep(0.25)
        items = reader.evidence(attempt1)
        body_ok = False
        size = 0
        if items:
            plain = reader.evidence_body(attempt1, items[0].evidence_id)
            size = len(plain)
            body_ok = b"planted-flag" in plain and b"VM{" not in plain and b"vm%7b" not in plain.lower()
        row_bytes = b"".join(r.sealed.ciphertext for r in evidence_store.rows(attempt1))
        check("evidence-sealed-and-readable", len(items) == 1 and body_ok and b"planted" not in row_bytes,
              f"{len(items)} sealed row(s) for C05, body of {size} bytes decrypts to the redacted request and holds no flag, stored bytes are sealed")

        # 3. a decoy and a flag of the other instance
        decoy = keys.decoy(iid1, "C02", 1, 0)
        status_d, _ = player_get(sidecar1, "/reflect?v=" + quote(decoy))
        other = keys.flag(iid2, "C05", 1)
        status_o, _ = player_get(sidecar1, "/reflect?v=" + quote(other))
        events: list[dict] = []
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not (any(e["type"] == "proxy.flag_seen" and e["data"]["kind"] == "decoy" for e in events)
                                                 and any(e["type"] == "proxy.flag_seen" and e["data"]["kind"] == "foreign" for e in events)):
            events += pump()
            time.sleep(0.25)
        kinds = sorted(e["data"]["kind"] for e in events if e["type"] == "proxy.flag_seen")
        check("decoy-not-credited", milestones.best(attempt1, "C02").value == "none" and integrity.of(attempt1, IntegrityType.DECOY)
              and "decoy" in kinds, f"requests answered {status_d}; sighting kinds {kinds}; C02 milestone {milestones.best(attempt1, 'C02').value}; "
              f"decoy integrity flags {len(integrity.of(attempt1, IntegrityType.DECOY))}")
        foreign_seen = "foreign" in kinds
        check("foreign-sighted-not-credited", foreign_seen and status_o == 200 and milestones.best(attempt1, "C02").value == "none"
              and len(integrity.of(attempt1, IntegrityType.SHARING)) == 1,
              f"sidecar reported a foreign sighting {foreign_seen}; the engine recognised the other instance's flag (sharing flags "
              f"{len(integrity.of(attempt1, IntegrityType.SHARING))}); no credit")

        # 4. paste submission
        attempts = FakeAttemptPort()
        attempts.seed(user_id="u-loop", state=AttemptState.RUNNING, attempt_id=attempt1)
        submit = FlagSubmitService(attempts=attempts, directory=directory, checker=checker, milestones=milestones, integrity=integrity,
                                   log=InMemoryFlagSubmissionLog(), clock=lambda: datetime.now(UTC))
        wrong = submit.submit_flag(attempt1, "C02", keys.flag(iid2, "C02", 1))
        right = submit.submit_flag(attempt1, "C02", keys.flag(iid1, "C02", 1))
        check("paste-submission", wrong.result == "incorrect" and right.result == "correct" and right.credit == "credited"
              and milestones.best(attempt1, "C02").value == "M3",
              f"other instance's flag pasted: {wrong.result}/{wrong.credit}; own flag pasted: {right.result}/{right.credit}; C02 now {milestones.best(attempt1, 'C02').value}")

        # 5. the second instance of the same template holds other flags
        r = docker("exec", shop2, "wget", "-q", "-O", "-", "http://127.0.0.1:3000/_stub/planted-flag?key=C05", timeout=30)
        try:
            flag2 = json.loads(r.stdout)["flag"]
        except (ValueError, KeyError):
            flag2 = ""
        first_flag = keys.flag(iid1, "C05", 1)
        check("second-instance-other-flags", bool(flag2) and flag2 == keys.flag(iid2, "C05", 1) and flag2 != first_flag
              and keys.flag(iid2, "C02", 1) != keys.flag(iid1, "C02", 1),
              "the second instance of the same template planted its own derived flags, different from the first instance's")

        # 6. activity metadata (aggregated proxy.request events arrive in the next 10 s window)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not activity.last_activity(iid1):
            pump()
            time.sleep(0.5)
        buckets = activity.store.buckets(iid1)
        check("activity-buckets-recorded", bool(buckets) and sum(b.requests for b in buckets) >= 1,
              f"{len(buckets)} minute bucket(s), {sum(b.requests for b in buckets)} request(s) counted, counts only; last activity recorded {activity.last_activity(iid1) is not None}")

        # 7. scan of this output and of the container logs (before the containers go)
        logs = work / "container-logs.txt"
        with logs.open("w", encoding="utf-8") as fh:
            for cid in (sidecar1, shop1, shop2, cid_of(iid2, "sidecar"), ingest_name, reflector_name):
                if cid:
                    lg = docker("logs", cid, timeout=30)
                    fh.write(lg.stdout + lg.stderr)
        own = work / "loop-output.txt"
        own.write_text("\n".join(OUT) + "\n", encoding="utf-8")
        scan = subprocess.run(["node", "scripts/scan-flags.mjs", "--file", str(own), "--file", str(logs)], cwd=ROOT, capture_output=True, text=True,
                              timeout=120)
        check("no-flag-in-output-or-logs", scan.returncode == 0, f"scripts/scan-flags.mjs on this output and on the logs of {6} containers: exit {scan.returncode}")
    except Exception as exc:  # never print a traceback with request data
        check("loop-error", False, f"{type(exc).__name__}: {str(exc)[:200]}")
    finally:
        for c in docker("ps", "-a", "-q", "--filter", f"label={LOOP_LABEL}").stdout.split():
            docker("rm", "-f", c)
        if orch is not None:
            for iid in iids:
                try:
                    orch.destroy(iid)
                except Exception:
                    pass
            for iid in instance_ids_in_docker():
                orch.destroy(iid)
        left = my_leftovers()
        check("nothing-left-over", not any(left.values()), ", ".join(f"{v} {k}" for k, v in left.items()))
        try:
            for f in work.iterdir():
                f.unlink()
            work.rmdir()
        except OSError:
            pass
    say(f"detect_loop: {'FAIL' if FAILED else 'PASS'} ({len(FAILED)} failed step(s)) in {time.monotonic() - t_start:.0f}s, LOCAL Docker Desktop only")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
