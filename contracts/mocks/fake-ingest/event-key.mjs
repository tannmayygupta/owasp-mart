// Event key derivation for instance events (IF-4, contracts/events/app-events.md section 4). ONE shared function for the mocks.
// HKDF-SHA256 (RFC 5869): salt = utf8 "vm-evt-salt-v1", info = "vm-event-key-v1" 0x00 instance_id 0x00 decimal(epoch), L = 32 bytes,
// encoded base64url without padding (43 characters). The master K_evt is 32 random bytes held by the platform; the mocks only ever get a
// throwaway test value. Node built-ins only.
import crypto from 'node:crypto';

export const EVENT_KEY_SALT = 'vm-evt-salt-v1';
export const EVENT_KEY_INFO = 'vm-event-key-v1';
export const EVENT_KEY_BYTES = 32;
// A FAKE master for tests, examples and the key vector. Never a real one: the real K_evt is 32 random bytes held by the platform and is never in the repository.
export const TEST_MASTER_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

// master: Buffer or hex string of 32 bytes. Returns the 43-character base64url event key for (instanceId, epoch).
export function deriveEventKey(master, instanceId, epoch) {
  const ikm = Buffer.isBuffer(master) ? master : Buffer.from(String(master), 'hex');
  if (ikm.length !== 32) throw new Error('the master key must be 32 bytes');
  if (typeof instanceId !== 'string' || !/^i-[A-Z2-7]{16}$/.test(instanceId)) throw new Error('bad instance id');
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('epoch must be an integer of at least 1');
  const info = Buffer.concat([Buffer.from(EVENT_KEY_INFO, 'utf8'), Buffer.from([0]), Buffer.from(instanceId, 'utf8'), Buffer.from([0]), Buffer.from(String(epoch), 'utf8')]);
  const okm = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from(EVENT_KEY_SALT, 'utf8'), info, EVENT_KEY_BYTES));
  return okm.toString('base64url');
}
