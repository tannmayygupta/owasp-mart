#!/usr/bin/env node
// Isolation probe from inside a real instance network (NFR-ISO-01 to 04, spikes S-3 and S-15, story 4.1).
//   node scripts/isolation-probe.mjs [--image <image>] [--timeout-ms 3000] [--out <report.json>]
// It builds what the orchestrator builds: an INTERNAL network and a hardened container (user 65532, read-only root, cap_drop ALL,
// no-new-privileges, limits, no mounts), plus a control container with the alias `sidecar` on the same network and a peer
// container on another internal network. From the probe container it tries every forbidden target and the control.
// A target is OPEN only after a completed TCP connect. Timeout, refusal, unreachable and name-not-found are BLOCKED.
// Exit 0: every forbidden target blocked and the control reached. 1: a target is open, the control is not reached, or the profile differs.
// 2: Docker is not available. Everything it creates carries the label vm.kind=isolation-probe and is removed in every case.
// Only the Docker CLI is used (Node built-ins). The output holds no secret and no address of this machine.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { checkInspect, RUN_USER } from './check-instance-conformance.mjs';

export const PROBE_LABEL = 'vm.kind=isolation-probe';
export const STUB_IMAGE = 'vulnmart-stub-instance:local';
export const FALLBACK_IMAGE = 'node:24.21.0-alpine';
export const LISTEN_PORT = 8080;
export const PEER_HTTPS_PORT = 443; // the peer also listens here: the host chain must not let a container reach another network's tcp/443 (audit blocker B4)

// The probe program, run with `node -e` inside the container. argv: JSON list of {name, host, port, control?}. Prints one JSON array.
export const PROBE_JS = [
  "const net=require('net');",
  'const targets=JSON.parse(process.argv[1]);const ms=Number(process.argv[2])||3000;',
  'const one=(t)=>new Promise((res)=>{',
  ' const started=Date.now();let done=false;',
  ' const fin=(state)=>{if(done)return;done=true;try{s.destroy()}catch(e){};res({name:t.name,state})};',
  ' const s=net.connect({host:t.host,port:t.port});s.setTimeout(ms);',
  " s.on('connect',()=>fin('open'));s.on('timeout',()=>fin('timeout'));",
  " s.on('error',(e)=>{const c=e&&e.code;fin(c==='ECONNREFUSED'?'refused':(c==='EHOSTUNREACH'||c==='ENETUNREACH'||c==='ENETDOWN')?'unreachable':(c==='ENOTFOUND'||c==='EAI_AGAIN')?'name-not-found':'error:'+(c||'unknown'))});",
  '});',
  'const tryOne=async(t)=>{if(!t.control)return one(t);let r;for(let i=0;i<10;i++){r=await one(t);if(r.state==="open")return r;await new Promise((x)=>setTimeout(x,500))}return r};',
  'Promise.all(targets.map(tryOne)).then((r)=>{process.stdout.write(JSON.stringify(r),()=>process.exit(0))});',
].join('');
// Listener for the sidecar and the peer: accepts and closes.
export const LISTEN_JS = `for(const p of [${LISTEN_PORT},${PEER_HTTPS_PORT}])require('net').createServer((s)=>s.end()).listen(p,'0.0.0.0');`;
const SLEEP_JS = 'setTimeout(()=>{},300000);';
// Checks that a listener answers on its own loopback (so a "blocked" peer is not just a peer that never started).
const SELF_JS = `const net=require('net');let n=0;const t=()=>{const s=net.connect(${LISTEN_PORT},'127.0.0.1');s.on('connect',()=>{process.stdout.write('up');process.exit(0)});s.on('error',()=>{if(++n>20){process.stdout.write('down');process.exit(1)}setTimeout(t,250)})};t();`;

/** Default Docker runner: the Docker CLI only. Returns { code, stdout, stderr } (code -1 when docker cannot be started). */
export function cliDocker(args, { timeout = 60000 } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
  if (r.error) return { code: -1, stdout: '', stderr: r.error.code === 'ENOENT' ? 'docker not found' : String(r.error.message) };
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal ?? null };
}

const lines = (s) => String(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/** The forbidden targets and the control, from the facts read from Docker (gateway, docker0, peer address). */
export function buildTargets({ gateway, docker0, peerIp }) {
  const t = [];
  for (const p of [22, 80, 443, 2375]) t.push({ name: `network-gateway:${p}`, host: gateway, port: p });
  t.push({ name: 'host.docker.internal:80', host: 'host.docker.internal', port: 80 });
  for (const p of [22, 2375]) t.push({ name: `docker0-address:${p}`, host: docker0, port: p });
  t.push({ name: `peer-instance-network:${LISTEN_PORT}`, host: peerIp, port: LISTEN_PORT });
  t.push({ name: `peer-instance-network:${PEER_HTTPS_PORT}`, host: peerIp, port: PEER_HTTPS_PORT });
  t.push({ name: 'metadata-169.254.169.254:80', host: '169.254.169.254', port: 80 });
  t.push({ name: 'public-address:443', host: '1.1.1.1', port: 443 });
  t.push({ name: 'public-address:53', host: '1.1.1.1', port: 53 });
  for (const h of ['10.0.0.1', '192.168.1.1', '10.255.255.254']) t.push({ name: `lan-${h}:443`, host: h, port: 443 });
  t.push({ name: 'platform-ingest-port:9444', host: '10.0.0.1', port: 9444 }); // the platform's event port is only for the control plane
  t.push({ name: 'platform-name:443', host: 'platform', port: 443 });
  t.push({ name: 'platform-like-name:443', host: 'api.vulnmart.internal', port: 443 });
  return t;
}

export const BLOCKED_STATES = ['timeout', 'refused', 'unreachable', 'name-not-found'];

/** Pure: decide the verdict from the answers of the probe. */
export function evaluate(targets, answers, { profileFailures = [] } = {}) {
  const byName = new Map(answers.map((a) => [a.name, a.state]));
  const rows = targets.map((t) => ({ name: t.name, state: byName.get(t.name) ?? 'no-answer', open: byName.get(t.name) === 'open' }));
  const control = byName.get('control-sidecar-alias');
  const open = rows.filter((r) => r.open).map((r) => r.name);
  const problems = [];
  for (const n of open) problems.push(`open: ${n}`);
  // Every target needs an answer that is a known blocked state: a missing answer or an error:* state proves nothing.
  for (const r of rows) if (!r.open && !BLOCKED_STATES.includes(r.state)) problems.push(`no valid answer for ${r.name} (state ${r.state})`);
  if (control !== 'open') problems.push(`control not reached (state ${control ?? 'no-answer'}): the probe is invalid, not isolated`);
  for (const f of profileFailures) problems.push(`profile: ${f}`);
  return { ok: problems.length === 0, rows, control: control ?? 'no-answer', open, problems };
}

// gVisor's own processes and threads count against the limits (found live, story L-29): the same overhead the orchestrator adds (apps/orchestrator backend.py).
export const SANDBOX_PIDS = 32 + 96;
export const SANDBOX_MEMORY_MB = 64 + 64;

function hardenedArgs(name, network, image, label, extra = [], sandboxed = false) {
  return ['run', '-d', '--name', name, '--label', label, '--network', network, ...extra,
    '--user', RUN_USER, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', sandboxed ? `${SANDBOX_MEMORY_MB}m` : '64m', '--cpus', '0.5', '--pids-limit', String(sandboxed ? SANDBOX_PIDS : 32), '--stop-timeout', '0',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=1m,uid=65532,gid=65532,mode=0750', '--entrypoint', 'node', image];
}

function removeLabelled(docker) {
  const label = `label=${PROBE_LABEL}`;
  const ps = docker(['ps', '-aq', '--filter', label]);
  const ids = lines(ps.stdout);
  if (ids.length) docker(['rm', '-f', ...ids]);
  const nets = lines(docker(['network', 'ls', '-q', '--filter', label]).stdout);
  if (nets.length) docker(['network', 'rm', ...nets]);
  const left = lines(docker(['ps', '-aq', '--filter', label]).stdout).length + lines(docker(['network', 'ls', '-q', '--filter', label]).stdout).length;
  return left;
}

const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

/** Runs the whole probe. `docker(args)` is injectable. Returns { exitCode, report }. */
export const abort = { flag: false }; // set by SIGINT/SIGTERM (main) or when a docker call was ended by a signal
export function runProbe({ docker: rawDocker = cliDocker, image, timeoutMs = 3000, log = () => {}, nonce = randomBytes(4).toString('hex'), probeSubnet, peerSubnet, runtime } = {}) {
  let cleaning = false;
  const docker = (args, o) => {
    if (abort.flag && !cleaning) throw new Error('aborted by a signal');
    const r = rawDocker(args, o);
    if (r?.signal === 'SIGINT' || r?.signal === 'SIGTERM') abort.flag = true;
    return r;
  };
  const v = docker(['version', '--format', '{{.Server.Version}}']);
  if (v.code !== 0) return { exitCode: 2, report: { error: 'Docker is not available: start Docker (Desktop or Engine) and run again.' } };
  const chosen = image ?? (docker(['image', 'inspect', STUB_IMAGE]).code === 0 ? STUB_IMAGE : FALLBACK_IMAGE);
  if (chosen === FALLBACK_IMAGE && docker(['image', 'inspect', FALLBACK_IMAGE]).code !== 0) docker(['pull', FALLBACK_IMAGE], { timeout: 300000 });

  const base = `vmprobe-${nonce}`;
  const netA = `${base}-a`; const netB = `${base}-b`;
  const names = { probe: `${base}-probe`, sidecar: `${base}-sidecar`, peer: `${base}-peer` };
  const label = PROBE_LABEL;
  let report; let exitCode = 1;
  try {
    const stale = removeLabelled(docker); // leftovers of a killed run
    if (stale) log(`note: ${stale} labelled object(s) could not be removed before the run`);
    // Optional fixed subnets (S-3 variant, story 4.3): a subnet outside the sets the host rules cover shows what the internal network alone blocks, without touching a firewall rule.
    for (const [n, subnet] of [[netA, probeSubnet], [netB, peerSubnet]]) {
      const r = docker(['network', 'create', '--internal', ...(subnet ? ['--subnet', subnet] : []), '--label', label, n]);
      if (r.code !== 0) throw new Error(`network create failed: ${r.stderr.trim().split('\n').pop()}`);
    }
    const start = (name, net, js, extra) => {
      // Optional container runtime (S-8, story 4.4): the same probe under another runtime, for example gVisor's runsc.
      const r = docker([...hardenedArgs(name, net, chosen, label, [...(runtime ? ['--runtime', runtime] : []), ...extra], runtime === 'runsc'), '-e', js]);
      if (r.code !== 0) throw new Error(`container start failed (${name}): ${r.stderr.trim().split('\n').pop()}`);
    };
    // host.docker.internal does not resolve on Linux without this mapping; with it the target is meaningful there too.
    start(names.probe, netA, SLEEP_JS, ['--add-host', 'host.docker.internal:host-gateway']);
    start(names.sidecar, netA, LISTEN_JS, ['--network-alias', 'sidecar']);
    start(names.peer, netB, LISTEN_JS, []);
    for (const n of [names.sidecar, names.peer]) {
      const r = docker(['exec', n, 'node', '-e', SELF_JS]);
      if (r.stdout.trim() !== 'up') throw new Error(`listener ${n.replace(base + '-', '')} did not start`);
    }
    // facts from Docker
    const netInfo = parse(docker(['network', 'inspect', netA]))?.[0];
    const gateway = netInfo?.IPAM?.Config?.[0]?.Gateway;
    const bridge = parse(docker(['network', 'inspect', 'bridge']))?.[0];
    const docker0 = bridge?.IPAM?.Config?.[0]?.Gateway || '172.17.0.1';
    const peerInfo = parse(docker(['inspect', names.peer]))?.[0];
    const peerIp = peerInfo?.NetworkSettings?.Networks?.[netB]?.IPAddress;
    if (!gateway || !peerIp) throw new Error('could not read the network gateway or the peer address from Docker');
    const subnetsOf = (n) => (n?.IPAM?.Config ?? []).map((c) => c.Subnet).filter(Boolean);
    const netBInfo = parse(docker(['network', 'inspect', netB]))?.[0];
    const probeSubnets = subnetsOf(netInfo); const peerSubnets = subnetsOf(netBInfo);

    // profile of the probe container, as docker inspect shows it
    const probeInfo = parse(docker(['inspect', names.probe]))?.[0];
    const profileFailures = [];
    if (!probeInfo) profileFailures.push('docker inspect of the probe container failed');
    else {
      for (const r of checkInspect([probeInfo])) if (!r.ok) profileFailures.push(`${r.rule}: ${r.detail}`);
      if (probeInfo.HostConfig?.NetworkMode !== netA) profileFailures.push('probe is not on the instance network only');
      if (Object.keys(probeInfo.NetworkSettings?.Networks ?? {}).join() !== netA) profileFailures.push('probe is attached to another network');
      if ((probeInfo.Mounts ?? []).length) profileFailures.push('probe has a mount');
      if (!(probeInfo.HostConfig?.PidsLimit > 0) || !(probeInfo.HostConfig?.Memory > 0)) profileFailures.push('limits missing');
    }
    if (netInfo?.Internal !== true) profileFailures.push('the instance network is not internal');
    // The peer must be on another network and another subnet, or the peer target proves nothing.
    if (netA === netB || Object.keys(peerInfo?.NetworkSettings?.Networks ?? {}).includes(netA)) profileFailures.push('the peer is on the probe network');
    if (!probeSubnets.length || !peerSubnets.length) profileFailures.push('subnets of the probe and peer networks are unknown');
    else if (peerSubnets.some((s) => probeSubnets.includes(s))) profileFailures.push('the peer network has the same subnet as the probe network');

    // Under gVisor Docker's embedded name server does not work (an alias never resolves, found live), so the control is reached by its address there; the question the
    // control answers is the same: can a container reach a sibling on its own network.
    const sidecarInfo = runtime === 'runsc' ? parse(docker(['inspect', names.sidecar]))?.[0] : null;
    const controlHost = runtime === 'runsc' ? sidecarInfo?.NetworkSettings?.Networks?.[netA]?.IPAddress : 'sidecar';
    if (!controlHost) throw new Error('could not read the address of the control container from Docker');
    const targets = buildTargets({ gateway, docker0, peerIp });
    const all = [...targets, { name: 'control-sidecar-alias', host: controlHost, port: LISTEN_PORT, control: true }];
    const ex = docker(['exec', names.probe, 'node', '-e', PROBE_JS, JSON.stringify(all), String(timeoutMs)], { timeout: 120000 });
    const answers = parse(ex);
    if (ex.code !== 0) throw new Error(`the probe program in the container failed (exit ${ex.code})`);
    if (!Array.isArray(answers) || answers.length !== all.length) throw new Error(`the probe program gave no complete answer (expected ${all.length} entries)`);
    const verdict = evaluate(targets, answers, { profileFailures });
    exitCode = verdict.ok ? 0 : 1;
    report = { ok: verdict.ok, image: chosen, ...(runtime ? { runtime } : {}), ...(runtime === 'runsc' ? { control_by: 'address' } : {}), profile: { user: RUN_USER, internal: netInfo?.Internal === true, failures: profileFailures }, subnets: { probe: probeSubnets, peer: peerSubnets, ...(probeSubnet || peerSubnet ? { custom: true } : {}) }, host_docker_internal: 'mapped with --add-host host.docker.internal:host-gateway', control: verdict.control, targets: verdict.rows.map(({ name, state, open }) => ({ name, state, open })), problems: verdict.problems };
  } catch (e) {
    report = { ok: false, error: e.message };
    exitCode = 1;
  } finally {
    cleaning = true;
    const left = removeLabelled(docker);
    if (abort.flag) { report = { ...(report ?? {}), ok: false, aborted: true, error: 'aborted by a signal' }; exitCode = 130; }
    if (report) { report.leftovers = left; if (left) { report.ok = false; if (exitCode !== 130) exitCode = 1; report.error = report.error ?? 'labelled objects remain after cleanup'; } }
  }
  return { exitCode, report };
}

/** A strict IPv4 network: four octets 0-255, prefix 16 to 29, host bits zero (the value goes to docker network create --subnet). */
export function validSubnet(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{2})$/.exec(String(s));
  if (!m) return false;
  const o = m.slice(1, 5).map(Number); const p = Number(m[5]);
  if (o.some((x) => x > 255) || p < 16 || p > 29) return false;
  const n = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const mask = (0xffffffff << (32 - p)) >>> 0;
  return (n & ~mask) >>> 0 === 0;
}

export function main(argv = process.argv.slice(2), { log = console.log, err = console.error, docker = cliDocker } = {}) {
  let image; let timeoutMs = 3000; let out; let probeSubnet; let peerSubnet; let runtime;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { log('Usage: node scripts/isolation-probe.mjs [--image <image>] [--timeout-ms <n>] [--out <report.json>] [--probe-subnet <cidr> --peer-subnet <cidr>] [--runtime <name>]'); return 0; }
    if ((argv[i] === '--probe-subnet' || argv[i] === '--peer-subnet') && argv[i + 1]) {
      const flag = argv[i]; const v = argv[++i];
      if (!validSubnet(v)) { err(flag + ' must be an IPv4 network such as 172.31.200.0/24 (prefix 16 to 29, host bits zero)'); return 2; }
      if (flag === '--probe-subnet') probeSubnet = v; else peerSubnet = v;
      continue;
    }
    if (argv[i] === '--runtime' && argv[i + 1]) {
      runtime = argv[++i];
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(runtime)) { err('--runtime must be a runtime name such as runsc (lower-case letters, digits and -)'); return 2; }
      continue;
    }
    if (argv[i] === '--image' && argv[i + 1]) {
      image = argv[++i];
      if (!/^[\w./:@-]+$/.test(image) || image.startsWith('-')) { err('--image must be an image name (letters, digits, . / : @ _ -) and must not start with "-"'); return 2; }
      continue;
    }
    if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      timeoutMs = Number(argv[++i]);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) { err('--timeout-ms must be a number from 100 to 60000'); return 2; }
      continue;
    }
    if (argv[i] === '--out' && argv[i + 1]) { out = argv[++i]; continue; }
    err(`Unknown argument: ${argv[i]}`);
    return 2;
  }
  if (probeSubnet && peerSubnet && probeSubnet === peerSubnet) { err('--probe-subnet and --peer-subnet must differ'); return 2; }
  abort.flag = false;
  const onSignal = () => { abort.flag = true; };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let result;
  try { result = runProbe({ docker, image, timeoutMs, log: err, probeSubnet, peerSubnet, runtime }); } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
  const { exitCode, report } = result;
  if (exitCode === 2) { err(report.error); return 2; }
  const text = JSON.stringify(report, null, 2);
  log(text);
  if (out) writeFileSync(out, `${text}\n`, 'utf8');
  if (exitCode) err(`isolation probe: FAIL ${(report.problems ?? [report.error]).join('; ')}`);
  else err(`isolation probe: PASS (${report.targets.length} forbidden targets blocked, control reached)`);
  return exitCode;
}

if (import.meta.main) process.exit(main());
