// Signing helper for instance events (IF-4). Used by the fake ingest, the tests and the example generator.
// Rule (contracts/events/app-events.md section 4): X-VM-Signature = "v1=" + hex(HMAC-SHA256(key, instance_id + "\n" + seq + "\n" + hex(SHA-256(body)))).
// The body is the exact bytes sent. Node built-ins only.
import crypto from 'node:crypto';

// An obviously fake key for tests and examples. A real per-instance key is never in the repository (architecture 06 section 3).
export const TEST_KEY = 'FAKE-EVENT-KEY-NOT-REAL-0000000000000000';
export const TEST_INSTANCE = 'i-AAAAAAAAAAAAAAAA';
export const SIGNATURE_HEADER = 'X-VM-Signature';

export function bodyDigest(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

export function signingString(instanceId, seq, body) {
  return `${instanceId}\n${seq}\n${bodyDigest(body)}`;
}

export function signBody(key, instanceId, seq, body) {
  return 'v1=' + crypto.createHmac('sha256', key).update(signingString(instanceId, seq, body)).digest('hex');
}

// Constant-time comparison of a header value with the expected signature.
export function verifySignature(key, instanceId, seq, body, header) {
  if (typeof header !== 'string' || !/^v1=[0-9a-f]{64}$/.test(header)) return false;
  const want = Buffer.from(signBody(key, instanceId, seq, body));
  const got = Buffer.from(header);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Serialise an event the way a sidecar would and sign it. Returns { body, headers }.
export function signEvent(key, event) {
  const body = JSON.stringify(event);
  return {
    body,
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER.toLowerCase()]: signBody(key, event.instance_id, event.seq, body) },
  };
}
