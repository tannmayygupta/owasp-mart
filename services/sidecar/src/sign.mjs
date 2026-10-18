// IF-4 signing (contracts/events/app-events.md section 4):
//   X-VM-Signature = "v1=" + hex(HMAC-SHA256(key, instance_id + "\n" + epoch + "\n" + seq + "\n" + hex(SHA-256(body))))
// The body is the exact bytes sent. Node built-ins only.
import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'X-VM-Signature';

export const bodyDigest = (body) => crypto.createHash('sha256').update(body).digest('hex');

export function signBody(key, instanceId, epoch, seq, body) {
  const signing = `${instanceId}\n${epoch}\n${seq}\n${bodyDigest(body)}`;
  return 'v1=' + crypto.createHmac('sha256', key).update(signing).digest('hex');
}
