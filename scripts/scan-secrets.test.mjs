// Secret and address scan: the tree is clean, and the scanner catches each kind of leak (fixtures are built at run time
// so this file itself never contains one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanFiles, trackedFiles, isPublicIPv4 } from './scan-secrets.mjs';

const ocid = ['ocid1', 'instance', 'oc1', 'ap-mumbai-1', 'a'.repeat(30)].join('.');
const pem = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const fpr = Array.from({ length: 16 }, (_, i) => (i * 7 + 10).toString(16).padStart(2, '0')).join(':');
const ip = [141, 148, 5, 9].join('.');

test('the working tree has no OCID, key, fingerprint, local file or public address', () => {
  const hits = scanFiles(trackedFiles());
  assert.deepEqual(hits, [], hits.map((h) => `${h.file}:${h.line} ${h.kind}`).join('\n'));
});

test('an OCID, a private key block and a fingerprint are caught', () => {
  assert.equal(scanText('a.md', `x ${ocid}`)[0].kind, 'OCID');
  assert.equal(scanText('a.md', pem)[0].kind, 'private key block');
  assert.equal(scanText('a.md', `fingerprint ${fpr}`)[0].kind, 'API key fingerprint');
});

test('placeholders are not flagged', () => {
  assert.deepEqual(scanText('a.md', 'ocid1.tenancy.oc1..<unique-id> and PASTE-FROM-OCI-CONSOLE'), []);
});

test('a public address is caught in the scoped folders and ignored elsewhere; private and documentation addresses pass', () => {
  assert.equal(scanText('docs/runbooks/x.md', `host ${ip}`)[0].kind, 'public IPv4 address');
  assert.deepEqual(scanText('docs/prd/x.md', `host ${ip}`), []);
  assert.deepEqual(scanText('docs/runbooks/x.md', '10.0.0.4 127.0.0.1 169.254.169.254 192.168.1.1 203.0.113.7 0.0.0.0/0 version 9.9.0'), []);
});

test('isPublicIPv4 knows the private ranges', () => {
  assert.equal(isPublicIPv4(172, 16, 0, 1), false);
  assert.equal(isPublicIPv4(172, 32, 0, 1), true);
  assert.equal(isPublicIPv4(8, 8, 8, 8), true);
  assert.equal(isPublicIPv4(300, 1, 1, 1), false);
});

test('files that must stay local are caught by name', () => {
  const hits = scanFiles(['infra/terraform/oci/terraform.tfvars', 'x/oci_api_key.pem', 'infra/terraform/oci/hosts.local.json', 'infra/terraform/oci/terraform.tfvars.example'], () => '', () => 0);
  assert.deepEqual(hits.map((h) => h.file), ['infra/terraform/oci/terraform.tfvars', 'x/oci_api_key.pem', 'infra/terraform/oci/hosts.local.json']);
});

test('Terraform variable files, plans, state backups and ssh private keys are caught by name; examples are not', () => {
  const bad = ['a/prod.tfvars', 'a/x.auto.tfvars', 'a/x.tfvars.json', 'a/tfplan', 'a/tfplan.out', 'a/x.tfplan', 'a/terraform.tfstate.backup', 'home/id_rsa', 'home/id_ed25519', 'home/id_ecdsa'];
  assert.deepEqual(scanFiles(bad, () => '', () => 0).map((h) => h.file), bad);
  assert.deepEqual(scanFiles(['infra/terraform/oci/terraform.tfvars.example', 'home/id_ed25519.pub'], () => '', () => 0), []);
});

test('the matched value is never part of a hit', () => {
  const hit = scanText('a.md', `x ${ocid}`)[0];
  assert.ok(!JSON.stringify(hit).includes('aaaaaaaaaa'));
});

// Fixtures are built at run time so this file never contains a real-looking key.
const keyId = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const acct = '1'.repeat(12);

test('an AWS access key id, a secret access key and an account id are caught', () => {
  assert.equal(scanText('a.md', `key ${keyId}`)[0].kind, 'AWS access key id');
  assert.equal(scanText('a.md', `aws_secret_access_key = ${'a'.repeat(40)}`)[0].kind, 'AWS secret access key');
  assert.equal(scanText('a.md', `arn:aws:iam::${acct}:user/x`)[0].kind, 'AWS account id');
  assert.equal(scanText('a.md', `account id: ${acct}`)[0].kind, 'AWS account id');
  assert.equal(scanText('a.md', `https://${acct}.signin.aws.amazon.com/console`)[0].kind, 'AWS account id');
});

test('AWS placeholders and wildcard ARNs are not flagged, and the hit never contains the value', () => {
  assert.deepEqual(scanText('a.md', 'arn:aws:budgets::*:budget/vulnmart-* and account id <redacted> and AKIA...'), []);
  assert.deepEqual(scanText('a.md', 'aws_secret_access_key = <your secret>'), []);
  assert.ok(!JSON.stringify(scanText('a.md', `key ${keyId}`)[0]).includes('ABCDEFGH'));
});

test('AWS credential files are caught by name', () => {
  const bad = ['home/.aws/credentials', 'home/.aws/config', 'x/credentials.csv', 'x/terraform_accessKeys.csv'];
  assert.deepEqual(scanFiles(bad, () => '', () => 0).map((h) => h.file), bad);
});

test('the SecretAccessKey JSON form, more id prefixes and a CSV row are caught (values built at test time)', () => {
  const secret = 'b'.repeat(40);
  assert.equal(scanText('a.md', `{"SecretAccessKey": "${secret}"}`)[0].kind, 'AWS secret access key');
  assert.equal(scanText('a.md', `secret_access_key: ${secret}`)[0].kind, 'AWS secret access key');
  for (const prefix of ['ANPA', 'AGPA', 'ASCA', 'ABIA', 'AIDA', 'AROA', 'ASIA']) assert.equal(scanText('a.md', `id ${prefix}${'Q'.repeat(16)}`)[0].kind, 'AWS access key id', prefix);
  assert.equal(scanText('a.md', `${keyId},${secret}`)[0].kind, 'AWS access key id');
  assert.deepEqual(scanText('a.md', '"SecretAccessKey": "<redacted>"'), []);
});
