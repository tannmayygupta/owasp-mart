// The events the sidecar builds itself (IF-4 section 7): proxy.flag_seen, evidence.capture, proxy.request. Everything on the player port
// is the owning player (D-76): source "sidecar", session_kind "player", user_id null. The platform maps the instance to the attempt and
// the user. Each builder returns the fields of a posted-style event; the outbox adds instance_id, epoch and seq and signs it.
// No builder takes a flag: a candidate is passed as its SHA-256 only.
const base = (type, ts, challengeKey, data) => ({
  schema_version: '0.1', type, source: 'sidecar', session_kind: 'player', user_id: null, ts,
  ...(challengeKey !== undefined ? { challenge_key: challengeKey } : {}), data,
});

export const isoNow = (now = Date.now) => new Date(now()).toISOString();

// candidate: { sha256, kind, challenge_key? } from the matcher. The challenge key is set for real and decoy only (IF-4 section 7 notes),
// and is the same in the envelope and in data.
export function flagSeenEvent({ candidate, routeTemplate, requestRef, ts }) {
  const withKey = candidate.kind === 'real' || candidate.kind === 'decoy';
  const data = {
    kind: candidate.kind,
    ...(withKey ? { challenge_key: candidate.challenge_key } : {}),
    candidate_sha256: candidate.sha256,
    route_template: routeTemplate,
    request_ref: requestRef,
  };
  return base('proxy.flag_seen', ts, withKey ? candidate.challenge_key : undefined, data);
}

// The envelope challenge_key is required for evidence.capture.
export function evidenceCaptureEvent({ challengeKey, requestRef, capture, ts }) {
  return base('evidence.capture', ts, challengeKey, { request_ref: requestRef, body: capture.body, headers_redacted: capture.headers_redacted });
}

// data: { rule_ids, tags, anomaly_score } already mapped by crs.mjs (matchData). No request text goes into this event.
export function crsMatchEvent({ data, routeTemplate, ts }) {
  return base('proxy.crs_match', ts, undefined, { rule_ids: data.rule_ids, tags: data.tags, anomaly_score: data.anomaly_score, route_template: routeTemplate });
}

export function proxyRequestEvent({ method, routeTemplate, status, respLen, count, ts }) {
  return base('proxy.request', ts, undefined, {
    method, route_template: routeTemplate, status, resp_len: respLen, client_class: 'player', count: Math.min(Math.max(count, 1), 1000000),
  });
}
