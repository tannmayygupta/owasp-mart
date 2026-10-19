// C10 in a deployed lab: the importer reaches the metadata service of its own instance when the player asks for the fixed metadata address in a form the string blocklist
// does not know (found live: before this the hints led nowhere, the instance network has no route to 169.254.169.254).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importImageFromUrl, routeMetadata } from '../../../apps/shop/src/challenges/c10-ssrf-import.mjs';

const ENV = { VM_MOCK_URL: 'http://mock-services' };

test('every written form of the metadata address is routed to the mock of the instance, other addresses are left alone', () => {
  for (const form of ['http://169.254.169.254/latest/user-data', 'http://2852039166/latest/user-data', 'http://0xa9fea9fe/latest/user-data', 'http://0251.0376.0251.0376/latest/user-data', 'http://169.254.169.254:80/latest/user-data?x=1']) {
    assert.equal(routeMetadata(form, ENV).startsWith('http://mock-services:9103/latest/user-data'), true, form);
  }
  assert.equal(routeMetadata('http://169.254.169.254/latest/user-data?x=1', ENV), 'http://mock-services:9103/latest/user-data?x=1');
  for (const other of ['http://example.com/a.png', 'http://169.254.169.254:8080/x', 'http://169.254.169.253/x', 'http://mock-services:9101/x', 'not a url']) assert.equal(routeMetadata(other, ENV), other, other);
  assert.equal(routeMetadata('http://2852039166/x', {}), 'http://2852039166/x', 'no mock configured: nothing is rewritten');
  assert.equal(routeMetadata('http://2852039166/x', { VM_MOCK_URL: 'http://evil.example/../x' }), 'http://2852039166/x', 'only a plain host is accepted as the mock');
});

test('vulnerable build: the decimal form passes the string blocklist and the answer of the mock is shown; the literal address and the fixed build refuse', async () => {
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); return new Response('FAKE-USER-DATA-NOT-A-FLAG', { headers: { 'content-type': 'text/plain' } }); };
  const env = process.env.VM_MOCK_URL; process.env.VM_MOCK_URL = 'http://mock-services';
  try {
    const ok = await importImageFromUrl('http://2852039166/latest/user-data', { challenges: { C10: 'vulnerable' }, fetchImpl });
    assert.equal(ok.error, 'Not an image: FAKE-USER-DATA-NOT-A-FLAG');
    assert.deepEqual(fetched, ['http://mock-services:9103/latest/user-data']);
    await assert.rejects(importImageFromUrl('http://169.254.169.254/latest/user-data', { challenges: { C10: 'vulnerable' }, fetchImpl }), /not allowed/);
    await assert.rejects(importImageFromUrl('http://2852039166/latest/user-data', { challenges: { C10: 'fixed' }, fetchImpl }), /not allowed/);
    assert.equal(fetched.length, 1, 'nothing else was fetched');
  } finally { if (env === undefined) delete process.env.VM_MOCK_URL; else process.env.VM_MOCK_URL = env; }
});