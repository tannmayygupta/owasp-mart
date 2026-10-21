// Access state of the gate: one record per instance, pushed by the orchestrator, kept in memory only (contracts/edge/gate-ticket.md section 5).
// An instance that has no record behaves as closed (fail closed). The access epoch only grows, as in IF-5.
import { INSTANCE_ID_RE, OWNER_RE, MAX_SAFE, isUint } from './tickets.mjs';

export const ACCESS_VALUES = ['open', 'frozen', 'closed'];
export const MAX_INSTANCES = 2000;
const FIELDS = ['hostname', 'instance_id', 'epoch', 'owner', 'access', 'access_epoch'];
const ZONE_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_LABEL_RE = /^i-[a-z2-7]{16}$/;

/** Validates the zone of the labs hostnames; returns it or throws (lower case, no trailing dot, at least two labels, no port). */
export function checkZone(zone) {
  if (typeof zone !== 'string' || zone.length > 200 || !ZONE_RE.test(zone)) throw new Error('zone must be a lower-case DNS name with at least two labels, no port, no trailing dot');
  return zone;
}

/**
 * The strict hostname rule (D-68). Returns the instance label ("i-" plus 16 lower-case base32 characters) or null.
 * Nothing is lower-cased, trimmed or normalised: a Host that is not exactly `i-<16 chars>.<zone>` is refused.
 */
export function instanceLabelFromHost(host, zone) {
  if (typeof host !== 'string' || host.length > 253) return null;
  const suffix = `.${zone}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, host.length - suffix.length);
  return HOST_LABEL_RE.test(label) ? label : null;
}

/** Strict validation of one state body. Returns { record } or { error }. */
export function validateRecord(body, zone) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'the body must be a JSON object' };
  const names = Object.keys(body);
  const extra = names.filter((k) => !FIELDS.includes(k));
  if (extra.length) return { error: 'unknown field' };
  const missing = FIELDS.filter((k) => !Object.hasOwn(body, k));
  if (missing.length) return { error: `missing field ${missing[0]}` };
  if (typeof body.instance_id !== 'string' || !INSTANCE_ID_RE.test(body.instance_id)) return { error: 'instance_id is not an instance id' };
  if (body.hostname !== `${body.instance_id.toLowerCase()}.${zone}`) return { error: 'hostname does not match the instance id and the zone' };
  if (!isUint(body.epoch) || body.epoch < 1) return { error: 'epoch is an integer of at least 1' };
  if (typeof body.owner !== 'string' || !OWNER_RE.test(body.owner)) return { error: 'owner is 64 lower-case hex characters' };
  if (typeof body.access !== 'string' || !ACCESS_VALUES.includes(body.access)) return { error: 'access is open, frozen or closed' };
  if (!isUint(body.access_epoch) || body.access_epoch > MAX_SAFE) return { error: 'access_epoch is an integer of at least 0' };
  return { record: { hostname: body.hostname, instance_id: body.instance_id, epoch: body.epoch, owner: body.owner, access: body.access, access_epoch: body.access_epoch } };
}

// The epoch rule: null when the push is allowed, else the reason (answered 409).
function conflict(cur, next) {
  if (!cur) return null;
  if (next.access_epoch < cur.access_epoch) return 'access_epoch is lower than the stored one';
  if (next.epoch < cur.epoch) return 'epoch is lower than the stored one';
  if (next.access_epoch === cur.access_epoch && (next.access !== cur.access || next.owner !== cur.owner)) return 'same access_epoch with another value';
  return null;
}

/** `onChange` is called after every change that is accepted (put, remove, sync): the edge saves its state there (persist.mjs). It must not throw into a push. */
export function createStore({ zone, onChange = () => {} }) {
  checkZone(zone);
  const map = new Map(); // label -> record

  const labelOf = (record) => record.instance_id.toLowerCase();
  const changed = () => { try { onChange(); } catch { /* a failing save must never fail the push; the saver counts it */ } };
  return {
    /** The record of an instance label, or undefined (unknown behaves as closed). */
    get: (label) => map.get(label),
    get size() { return map.size; },
    /** Every record (a copy), for the saved state. */
    list: () => [...map.values()].map((r) => ({ ...r })),
    /** Loads records that were validated by persist.mjs into an EMPTY store at start; the epoch rules still apply to every later push. */
    restore(records) {
      if (map.size !== 0) throw new Error('restore is for an empty store');
      for (const r of records) map.set(labelOf(r), { ...r });
    },
    /** PUT one instance. Returns { status: 204 } or { status, error }. */
    put(idFromPath, body) {
      const v = validateRecord(body, zone);
      if (v.error) return { status: 422, error: v.error };
      if (v.record.instance_id !== idFromPath) return { status: 422, error: 'instance_id differs from the path' };
      const label = labelOf(v.record);
      const why = conflict(map.get(label), v.record);
      if (why) return { status: 409, error: why };
      if (!map.has(label) && map.size >= MAX_INSTANCES) return { status: 422, error: 'too many instances' };
      map.set(label, v.record);
      changed();
      return { status: 204 };
    },
    remove(idFromPath) {
      map.delete(idFromPath.toLowerCase());
      changed();
      return { status: 204 };
    },
    /** The full list of the orchestrator: all or nothing; instances not in the list are removed. */
    sync(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Array.isArray(body.instances)) return { status: 422, error: 'the body is {"instances": [...]}' };
      if (body.instances.length > MAX_INSTANCES) return { status: 422, error: 'too many instances' };
      const next = new Map();
      for (const item of body.instances) {
        const v = validateRecord(item, zone);
        if (v.error) return { status: 422, error: v.error };
        const label = labelOf(v.record);
        if (next.has(label)) return { status: 422, error: 'instance listed twice' };
        next.set(label, v.record);
      }
      for (const [label, rec] of next) {
        const why = conflict(map.get(label), rec);
        if (why) return { status: 409, error: why };
      }
      map.clear();
      for (const [label, rec] of next) map.set(label, rec);
      changed();
      return { status: 204 };
    },
  };
}
