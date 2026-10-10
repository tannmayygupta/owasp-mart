// Policy check for infra/network-rules.json (the one file Terraform reads for firewall rules).
// A new public port, or SSH from everywhere, fails with the name of the rule. Usage: node scripts/check-network-rules.mjs [file]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RULES_FILE = path.join(ROOT, 'infra', 'network-rules.json');
export const ALLOWED_PUBLIC_PORTS = [22, 80, 443];
const SSH_TOKEN = '$ssh_source_cidrs';
const WEB_TOKEN = '$public_web_cidrs';
const EVERYWHERE =new Set(['0.0.0.0/0', '::/0']);
const VMS = new Set(['vm-p', 'vm-i']);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function parseV4(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr));
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (o.some((n) => n > 255) || bits > 32) return null;
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { start: (ip & mask) >>> 0, bits, mask };
}

/** True when the IPv4 CIDR inner lies completely inside outer. */
export function cidrInside(inner, outer) {
  const a = parseV4(inner);
  const b = parseV4(outer);
  return !!a && !!b && a.bits >= b.bits && ((a.start & b.mask) >>> 0) === b.start;
}

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

/** @returns {string[]} one message per problem; empty means the rules pass */
export function checkRules(rules) {
  const problems = [];
  const add = (m) => problems.push(m);
  if (!isObject(rules)) return ['the rule file must be a JSON object'];
  if (rules.schema !== 1) add('schema must be 1');
  if (!cidrInside(rules.subnet_cidr, rules.vcn_cidr)) add('subnet_cidr must be a valid IPv4 CIDR inside vcn_cidr');
  const names = new Set();
  const pub = Array.isArray(rules?.public_ingress) ? rules.public_ingress : [];
  if (!Array.isArray(rules?.public_ingress)) add('public_ingress must be a list');
  for (const [i, r] of pub.entries()) {
    if (!isObject(r)) {
      add(`public_ingress[${i}]: entry must be an object, not ${r === null ? 'null' : typeof r}`);
      continue;
    }
    const n = r.name ?? '(unnamed)';
    if (names.has(n)) add(`rule ${n}: duplicate name`);
    names.add(n);
    if (r.protocol !== 'tcp') add(`public rule ${n}: only tcp is allowed`);
    if (!validPort(r.port)) add(`public rule ${n}: port must be a single number (no ranges)`);
    else if (!ALLOWED_PUBLIC_PORTS.includes(r.port)) add(`public rule ${n}: port ${r.port} is not allowed from the internet (allowed: ${ALLOWED_PUBLIC_PORTS.join(', ')})`);
    if (!Array.isArray(r.sources) || r.sources.length === 0) add(`public rule ${n}: sources must be a non-empty list`);
    else if (r.port === 22) {
      if (r.sources.some((s) => EVERYWHERE.has(s))) add(`public rule ${n}: port 22 must not be open to ${r.sources.filter((s) => EVERYWHERE.has(s)).join(', ')}`);
      if (r.sources.length !== 1 || r.sources[0] !== SSH_TOKEN) add(`public rule ${n}: port 22 sources must be exactly ["${SSH_TOKEN}"] (the listed source addresses)`);
    } else if (r.port === 80 || r.port === 443) {
      if (r.sources.length !== 1 || r.sources[0] !== WEB_TOKEN) add(`public rule ${n}: port ${r.port} sources must be exactly ["${WEB_TOKEN}"] (the web source list; 0.0.0.0/0 is never written into the rule file, only set on purpose through the variable)`);
    }
    if (r.port !== 22 && Array.isArray(r.sources) && r.sources.includes(SSH_TOKEN)) add(`public rule ${n}: the ssh source token is only for port 22`);
    if (r.port !== 80 && r.port !== 443 && Array.isArray(r.sources) && r.sources.includes(WEB_TOKEN)) add(`public rule ${n}: the web source token is only for ports 80 and 443`);
  }
  for (const p of ALLOWED_PUBLIC_PORTS) if (!pub.some((r) => r?.port === p)) add(`public port ${p} is missing from the rules`);
  for (const [i, r] of (Array.isArray(rules?.icmp_ingress) ? rules.icmp_ingress : []).entries()) {
    if (!isObject(r)) {
      add(`icmp_ingress[${i}]: entry must be an object`);
      continue;
    }
    if (r.type !== 3 || r.code !== 4) add(`icmp rule ${r?.name ?? '(unnamed)'}: only type 3 code 4 (path MTU) is allowed`);
    const icmpName = r.name ?? '(unnamed)';
    if (names.has(icmpName)) add(`rule ${icmpName}: duplicate name`);
    names.add(icmpName);
  }
  const priv = Array.isArray(rules?.private_ingress) ? rules.private_ingress : [];
  for (const [i, r] of priv.entries()) {
    if (!isObject(r)) {
      add(`private_ingress[${i}]: entry must be an object, not ${r === null ? 'null' : typeof r}`);
      continue;
    }
    const n = r.name ?? '(unnamed)';
    if (names.has(n)) add(`rule ${n}: duplicate name`);
    names.add(n);
    if (r.protocol !== 'tcp') add(`private rule ${n}: only tcp is allowed`);
    if (!validPort(r.port)) add(`private rule ${n}: port must be a single number`);
    else if (ALLOWED_PUBLIC_PORTS.includes(r.port)) add(`private rule ${n}: port ${r.port} is a public port; use a named private port`);
    if (!VMS.has(r.from) || !VMS.has(r.to) || r.from === r.to) add(`private rule ${n}: from and to must be vm-p and vm-i, different`);
    if ('sources' in r || EVERYWHERE.has(r.source)) add(`private rule ${n}: private rules name a VM (from), never an address`);
  }
  return problems;
}

/** Blocks of a Terraform file where a literal "0.0.0.0/0" or "::/0" is allowed: egress, ICMP path MTU, default routes, the closed default groups. */
const EXEMPT_HEADER = /^resource "(aws_vpc_security_group_egress_rule|aws_route_table|oci_core_default_route_table|oci_core_default_security_list)"|^resource "aws_vpc_security_group_ingress_rule" "icmp"|^resource "oci_core_network_security_group_security_rule" "egress"/;

/** Static checks of network.tf: it must read the data file and carry no port numbers or open sources of its own. */
export function checkTerraformReadsRules(tfText) {
  const problems = [];
  if (!/jsondecode\(file\("\$\{path\.module\}\/\.\.\/\.\.\/network-rules\.json"\)\)/.test(tfText)) problems.push('network.tf does not read network-rules.json');
  if (/^\s*(min|max|from_port|to_port)\s*=\s*\d+\s*$/m.test(tfText)) problems.push('network.tf has a literal port number; ports must come from network-rules.json');
  const blocks = tfText.split(/^(?=resource |data |locals |variable |output )/m);
  for (const block of blocks) {
    const header = block.split('\n', 1)[0];
    if (EXEMPT_HEADER.test(header)) continue;
    if (/"0\.0\.0\.0\/0"/.test(block)) problems.push(`network.tf: a literal 0.0.0.0/0 outside the egress, ICMP and default-route blocks (in: ${header.trim()}); ingress sources come from the rule file`);
    if (/"::\/0"/.test(block)) problems.push(`network.tf: a literal ::/0 outside the egress, ICMP and default-route blocks (in: ${header.trim()})`);
  }
  return problems;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? RULES_FILE;
  const problems = checkRules(JSON.parse(readFileSync(file, 'utf8')));
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`PASS network rules: public ports ${ALLOWED_PUBLIC_PORTS.join(', ')} only`);
}
