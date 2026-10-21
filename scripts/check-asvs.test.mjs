import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { check, parse, EXPECTED } from './check-asvs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const small = { total: 2, levels: { 1: 1, 2: 1, 3: 0 } }
const ok = (p) => p === 'a/b.py'
const row = (id, l, ap, st, ev, ow, note) => `| ${id} | ${l} | ${ap} | ${st} | ${ev} | ${ow} | ${note} |`
const good = [row('V1.1.1', 2, 'yes', 'met', '`a/b.py`', '-', 'x'), row('V2.1.1', 1, 'yes', 'partly', '`a/b.py`', 'G', 'y')].join('\n')

test('a complete table passes', () => {
  assert.deepEqual(check(good, '.', { expected: small, pathExists: ok }).problems, [])
})

test('a row without evidence, a bad status, a missing owner and a missing file are all reported', () => {
  const text = [row('V1.1.1', 2, 'yes', 'ok', '', '-', 'x'), row('V2.1.1', 1, 'yes', 'partly', '`gone.py`', '-', '')].join('\n')
  const p = check(text, '.', { expected: small, pathExists: ok }).problems.join('\n')
  assert.match(p, /V1\.1\.1: status "ok"/)
  assert.match(p, /V1\.1\.1: no evidence/)
  assert.match(p, /V2\.1\.1: evidence path does not exist: gone\.py/)
  assert.match(p, /V2\.1\.1: a gap needs an owner package/)
  assert.match(p, /V2\.1\.1: no note/)
})

test('a duplicate id, a wrong count and an n.a. that applies are reported', () => {
  const text = [good, row('V1.1.1', 2, 'no', 'met', '`a/b.py`', '-', 'x')].join('\n')
  const p = check(text, '.', { expected: small, pathExists: ok }).problems.join('\n')
  assert.match(p, /V1\.1\.1: listed twice/)
  assert.match(p, /expected 2 requirements, found 3/)
  assert.match(p, /"n\.a\." and "no" go together/)
})

test('an unreadable row is reported', () => {
  assert.match(parse('| V1.1.1 | 2 | yes |').bad.join(), /unreadable row/)
})

test('the real checklist is complete and its files exist', () => {
  const text = readFileSync(path.join(root, 'docs', 'security', 'asvs-checklist.md'), 'utf8')
  const { problems, rows } = check(text, root)
  assert.deepEqual(problems, [])
  assert.equal(rows.length, EXPECTED.total)
})
