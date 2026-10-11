// A resolved compose config (shaped like `docker compose config --format json`) that conforms to the instance runtime profile, written out by hand
// so the unit tests of the conformance check and of the harness need no Docker. Test support only.
import { VOLUMES } from './check-instance-conformance.mjs';

export const DOCKERFILE_OK = `FROM node:24.21.0-alpine@sha256:${'a'.repeat(64)}\nUSER 65532:65532\n`;

const base = (kind, extra = {}) => ({
  image: 'vulnmart-stub-instance:local', user: '65532:65532', read_only: true, privileged: false, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
  mem_limit: '134217728', cpus: 0.5, pids_limit: 64, labels: { 'vm.kind': kind }, networks: { inst: null },
  tmpfs: ['/tmp:rw,noexec,nosuid,size=16m,uid=65532,gid=65532,mode=1777'], environment: { TZ: 'UTC', PORT: '3000' },
  ...extra,
});
const after = { injector: { condition: 'service_completed_successfully', required: true } };

export function goodConfig() {
  const c = {
    services: {
      'volume-keeper': base('harness', { network_mode: 'none', networks: undefined, volumes: Object.entries(VOLUMES).map(([source, target]) => ({ type: 'volume', source, target, read_only: true })) }),
      ingest: base('harness', { networks: { link: null } }),
      injector: base('inst', { network_mode: 'none', networks: undefined, volumes: [{ type: 'volume', source: 'vm-run', target: '/run/vm' }, { type: 'volume', source: 'vm-placement-import', target: '/run/placement/import' }, { type: 'volume', source: 'vm-placement-mock', target: '/run/placement/mock' }] }),
      shop: base('inst', { depends_on: after, volumes: [{ type: 'volume', source: 'vm-run', target: '/run/vm', read_only: true }, { type: 'volume', source: 'vm-import', target: '/run/import' }], healthcheck: { test: ['CMD', 'wget', 'http://127.0.0.1:3000/readyz'] } }),
      sidecar: base('inst', { depends_on: after }),
      gate: base('inst', { depends_on: after }),
      edge: base('inst', { depends_on: after, networks: { inst: null, link: null, front: null }, ports: [{ mode: 'ingress', host_ip: '127.0.0.1', target: 8080, published: '18090', protocol: 'tcp' }] }),
    },
    networks: { inst: { internal: true }, link: { internal: true }, front: { driver: 'bridge' } },
    volumes: Object.fromEntries(Object.keys(VOLUMES).map((n) => [n, { driver: 'local', driver_opts: { type: 'tmpfs', device: 'tmpfs', o: 'size=2m,uid=65532,gid=65532,mode=0750' } }])),
  };
  return JSON.parse(JSON.stringify(c)); // drops the undefined keys
}
