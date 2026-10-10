// Fresh, throwaway test values for the stub instance and the harness (story L-06). Made new at every run and never written to a
// tracked file, a log or a doc. The flag format is built from pieces so that no flag-looking literal exists in the source.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const rand = (alphabet, n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
export const CHALLENGE_KEYS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'];
export const fakeFlag = () => 'VM' + String.fromCharCode(123) + rand(B32, 24) + String.fromCharCode(125);
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function freshValues({ keys = CHALLENGE_KEYS } = {}) {
  return {
    instance_id: 'i-' + rand(B32, 16),
    epoch: 1,
    first_seq: 100 + crypto.randomInt(900), // not 1, so a test sees that first_seq is honoured
    seed: rand('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', 48),
    event_key: 'FAKE-TEST-KEY-' + rand('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 40),
    flags: keys.map((challenge_key) => ({ challenge_key, flag: fakeFlag() })),
  };
}

export const injectionDocument = (v) => ({ schema_version: '0.1', instance_id: v.instance_id, epoch: v.epoch, seed: v.seed, flags: v.flags, decoys: [] });

export const sidecarStartDocument = (v) => ({
  schema_version: '0.1',
  instance_id: v.instance_id,
  epoch: v.epoch,
  first_seq: v.first_seq,
  event_key: v.event_key,
  flag_digests: v.flags.map((f) => ({ challenge_key: f.challenge_key, kind: 'real', sha256: sha256(f.flag) })),
});
