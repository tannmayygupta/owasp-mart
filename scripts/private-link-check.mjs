// Live check of the private link between VM-P and VM-I (spike S-17, runbook Part C).
// For each direction named in network-rules.json (private_ingress) it proves: TCP connects, a mutual-TLS handshake
// succeeds with throwaway certificates, a client without a certificate is refused, and records the connect latency.
// Also proves the link ports are closed from the internet. Certificates live only in a 0700 folder in /dev/shm on the
// hosts and are removed at the end (checked). Usage: node scripts/private-link-check.mjs --identity <key> [--hosts file]
// [--user ubuntu] [--evidence file]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHosts, redact, tcpProbe as realProbe, sshRun, printChecks, parseArgs } from './oracle-hosts.mjs';
import { RULES_FILE } from './check-network-rules.mjs';

export const SERVER_PY = `import socket, ssl, sys, time
d, ip, port, secs = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.minimum_version = ssl.TLSVersion.TLSv1_2
ctx.verify_mode = ssl.CERT_REQUIRED
ctx.load_cert_chain(d + "/node.crt", d + "/node.key")
ctx.load_verify_locations(d + "/ca.crt")
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((ip, port)); s.listen(16); s.settimeout(1.0)
end = time.time() + secs
print("listening", flush=True)
while time.time() < end:
    try:
        c, _ = s.accept()
    except socket.timeout:
        continue
    try:
        c.settimeout(5)
        t = ctx.wrap_socket(c, server_side=True)
        t.sendall(b"mtls-ok\\n")
        t.close()
    except Exception as e:
        print("rejected:", type(e).__name__, flush=True)
        try: c.close()
        except Exception: pass
`;

export const CLIENT_PY = `import json, socket, ssl, sys, time, statistics
d, host, port, mode = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
def connect_ms():
    t = time.perf_counter(); s = socket.create_connection((host, port), timeout=5); ms = (time.perf_counter() - t) * 1000; return s, ms
try:
    if mode == "probe":
        try:
            s = socket.create_connection((host, port), timeout=4); s.close(); st = "open"
        except socket.timeout:
            st = "timeout"
        except ConnectionRefusedError:
            st = "refused"
        except OSError as e:
            st = "error:" + type(e).__name__
        print(json.dumps({"state": st}))
    elif mode == "latency":
        xs = []
        for _ in range(20):
            s, ms = connect_ms(); s.close(); xs.append(ms); time.sleep(0.05)
        xs.sort()
        print(json.dumps({"ok": True, "n": len(xs), "min_ms": round(xs[0], 2), "median_ms": round(statistics.median(xs), 2), "p95_ms": round(xs[int(len(xs) * 0.95) - 1], 2), "max_ms": round(xs[-1], 2)}))
    else:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_verify_locations(d + "/ca.crt")
        if mode == "mtls":
            ctx.load_cert_chain(d + "/node.crt", d + "/node.key")
        s, tcp_ms = connect_ms()
        t0 = time.perf_counter()
        t = ctx.wrap_socket(s, server_hostname=host)
        hs = (time.perf_counter() - t0) * 1000
        data = t.recv(64)
        print(json.dumps({"ok": data.startswith(b"mtls-ok"), "tls": t.version(), "tcp_ms": round(tcp_ms, 2), "handshake_ms": round(hs, 2)}))
except Exception as e:
    print(json.dumps({"ok": False, "error": type(e).__name__}))
`;

const parseJson = (text) => {
  try {
    return JSON.parse(String(text).trim().split('\n').pop());
  } catch {
    return null;
  }
};

// Time one client step may take, and the server lifetime derived from it: every server stops by itself
// (client steps of one link) x (seconds per step) + a margin, even if the clean-up never runs.
export const CLIENT_STEPS_PER_LINK = 5;
export const SECONDS_PER_STEP = 20;
export const SERVER_SECONDS = CLIENT_STEPS_PER_LINK * SECONDS_PER_STEP + 20;
// A client without a certificate must fail at TLS level (not a timeout, not a refused connection).
export const TLS_ERRORS = /^(SSLError|SSLEOFError|SSLZeroReturnError|ConnectionResetError)$/;

/** A port that is in no rule, for the "not in the rules" probe. */
export function unlistedPort(rules) {
  const used = new Set([...rules.public_ingress, ...rules.private_ingress].map((r) => r.port));
  let p = 9445;
  while (used.has(p)) p++;
  return p;
}

export async function checkPrivateLink({ hosts, rules, ssh, tcpProbe, identity, user = 'ubuntu', dirName = `vm-link-${randomBytes(6).toString('hex')}` }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const dir = `/dev/shm/${dirName}`;
  const run = (vm, command, input) => ssh({ host: hosts[vm].pub, user, identity, command, input });
  const links = rules.private_ingress;
  const pids = { 'vm-p': [], 'vm-i': [] }; // saved process ids of the servers this run started

  // Link blocked from the internet side.
  for (const l of links) {
    for (const vm of ['vm-p', 'vm-i']) {
      const state = await tcpProbe(hosts[vm].pub, l.port);
      add(`${l.name} port ${l.port} closed on ${vm} public address`, state !== 'open', state);
    }
  }

  try {
    for (const vm of ['vm-p', 'vm-i']) {
      const r = await run(vm, `umask 077; mkdir -m 700 ${dir} && command -v python3 >/dev/null && echo ready`);
      add(`${vm} work folder created and python3 present`, r.code === 0 && /ready/.test(r.stdout), r.code === 0 ? '' : r.stderr.trim());
      if (r.code !== 0) return checks;
    }
    // Throwaway CA and one node certificate (both private addresses, server and client use), made on VM-P, copied to VM-I.
    const san = `subjectAltName=IP:${hosts['vm-p'].priv},IP:${hosts['vm-i'].priv}`;
    const gen = [
      'set -e', `cd ${dir}`,
      'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.crt -subj /CN=vulnmart-throwaway-ca -days 1 2>/dev/null',
      'openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout node.key -out node.csr -subj /CN=vulnmart-throwaway-node 2>/dev/null',
      `printf '${san}\\nextendedKeyUsage=serverAuth,clientAuth\\n' > ext.cnf`,
      'openssl x509 -req -in node.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out node.crt -days 1 -extfile ext.cnf 2>/dev/null',
      'tar c ca.crt node.crt node.key | base64 -w0',
    ].join('; ');
    const g = await run('vm-p', gen);
    add('throwaway certificates generated on vm-p', g.code === 0 && g.stdout.trim().length > 100, g.code === 0 ? '' : g.stderr.trim());
    if (g.code !== 0) return checks;
    const cp = await run('vm-i', `cd ${dir} && base64 -d | tar x`, g.stdout.trim());
    add('throwaway certificates copied to vm-i', cp.code === 0, cp.code === 0 ? '' : cp.stderr.trim());
    for (const vm of ['vm-p', 'vm-i']) {
      await run(vm, `cat > ${dir}/server.py`, SERVER_PY);
      await run(vm, `cat > ${dir}/client.py`, CLIENT_PY);
    }

    for (const l of links) {
      const label = `${l.from} -> ${l.to} :${l.port}`;
      const srv = hosts[l.to];
      const log = `${dir}/server-${l.port}.log`;
      const started = await run(l.to, `cd ${dir} && (nohup python3 -I server.py ${dir} ${srv.priv} ${l.port} ${SERVER_SECONDS} > ${log} 2>&1 & echo $!); sleep 2; cat ${log}`);
      const pid = (started.stdout.match(/^(\d+)$/m) ?? [])[1];
      if (pid) pids[l.to].push(pid);
      add(`${label} server listening on the private address`, !!pid && /listening/.test(started.stdout), /listening/.test(started.stdout) ? '' : (started.stdout.trim() || started.stderr.trim()));
      const client = (mode, host = srv.priv, port = l.port, from = l.from) => run(from, `python3 -I ${dir}/client.py ${dir} ${host} ${port} ${mode}`);
      const tcp = parseJson((await client('latency')).stdout);
      add(`${label} TCP connects over the private address`, !!tcp?.ok, tcp?.ok ? `connect ms min ${tcp.min_ms} median ${tcp.median_ms} p95 ${tcp.p95_ms} max ${tcp.max_ms} (n=${tcp.n})` : JSON.stringify(tcp));
      const m = parseJson((await client('mtls')).stdout);
      add(`${label} mutual-TLS handshake succeeds`, !!m?.ok, m?.ok ? `${m.tls} tcp ${m.tcp_ms} ms handshake ${m.handshake_ms} ms` : JSON.stringify(m));
      // Without a certificate: the client must fail at TLS level and the server log must show the rejection.
      const before = Number(((await run(l.to, `wc -l < ${log}`)).stdout.trim().match(/\d+/) ?? ['0'])[0]);
      const n = parseJson((await client('nocert')).stdout);
      const tail = (await run(l.to, `tail -n +${before + 1} ${log}`)).stdout;
      const refused = n?.ok === false && TLS_ERRORS.test(n.error ?? '') && /rejected:/.test(tail);
      add(`${label} client without a certificate is refused`, refused, n ? `client error ${n.error ?? 'none'}; server log ${/rejected:/.test(tail) ? 'shows the rejection' : 'shows no rejection'}` : 'no output');
      await run(l.to, `kill ${pid ?? '0'} 2>/dev/null; true`);
      pids[l.to] = pids[l.to].filter((x) => x !== pid);

      // The network groups decide direction and ports: the wrong direction and an unlisted port must be dropped (timeout).
      const reverse = !links.some((x) => x.from === l.to && x.to === l.from && x.port === l.port);
      if (reverse) {
        const r = parseJson((await client('probe', hosts[l.from].priv, l.port, l.to)).stdout);
        add(`${l.to} -> ${l.from} :${l.port} (wrong direction) is dropped`, r?.state === 'timeout', r?.state ?? 'no output');
      }
      const other = unlistedPort(rules);
      const u = parseJson((await client('probe', srv.priv, other, l.from)).stdout);
      add(`${l.from} -> ${l.to} :${other} (port not in the rules) is dropped`, u?.state === 'timeout', u?.state ?? 'no output');
    }
  } finally {
    // Stop only the servers this run started (saved ids), then remove the folder, then check it is gone. No pattern kill.
    for (const vm of ['vm-p', 'vm-i']) {
      const kills = pids[vm].filter((p) => /^\d+$/.test(p)).map((p) => `kill ${p} 2>/dev/null`).join('; ');
      await run(vm, `${kills ? `${kills}; ` : ''}rm -rf ${dir}; true`);
      const left = await run(vm, `test ! -e ${dir} && echo clean || echo left`);
      add(`${vm} no certificate or key left on the host`, /clean/.test(left.stdout), left.stdout.trim());
    }
  }
  return checks;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), { values: ['identity', 'hosts', 'user', 'evidence'] });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (!opts.identity) {
    console.error('usage: node scripts/private-link-check.mjs --identity <ssh-private-key-path> [--hosts file] [--user ubuntu] [--evidence file]');
    process.exit(2);
  }
  const hosts = loadHosts(opts.hosts);
  const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  const checks = await checkPrivateLink({ hosts, rules, ssh: sshRun, tcpProbe: realProbe, identity: opts.identity, user: opts.user ?? 'ubuntu' });
  const lines = [];
  const ok = printChecks(checks, (l) => {
    const r = redact(l, hosts);
    lines.push(r);
    console.log(r);
  });
  if (opts.evidence) {
    mkdirSync(path.dirname(path.resolve(opts.evidence)), { recursive: true });
    writeFileSync(opts.evidence, `private-link-check ${new Date().toISOString()}\n${lines.join('\n')}\n`);
    console.log(`evidence saved to ${opts.evidence} (addresses redacted)`);
  }
  process.exit(ok ? 0 : 1);
}
