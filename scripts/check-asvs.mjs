#!/usr/bin/env node
// Checks docs/security/asvs-checklist.md (task P-32, NFR-SEC-01): one row per ASVS 5.0.0 requirement, a valid status, an owner, evidence on every row,
// and every file or folder named in the evidence exists. Exit 1 with the list of problems, 0 when the file is complete.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STATUSES = ['met', 'partly', 'not met', 'n.a.']
export const APPLIES = ['yes', 'L3 scope', 'no']
export const EXPECTED = { total: 345, levels: { 1: 70, 2: 183, 3: 92 } } // the official 5.0.0 list, read 2026-10-21
const ROW = /^\| (V\d{1,2}\.\d{1,2}\.\d{1,2}) \| ([123]) \| ([^|]+) \| ([^|]+) \| ([^|]*) \| ([^|]*) \| ([^|]*) \|$/

export function parse(text) {
  const rows = []
  const bad = []
  for (const line of text.split(/\r?\n/)) {
    if (!/^\| V\d/.test(line)) continue
    const m = ROW.exec(line)
    if (!m) { bad.push(`unreadable row: ${line.slice(0, 60)}`); continue }
    rows.push({ id: m[1], level: Number(m[2]), applies: m[3].trim(), status: m[4].trim(), evidence: m[5].trim(), owner: m[6].trim(), note: m[7].trim() })
  }
  return { rows, bad }
}

export function check(text, root, { expected = EXPECTED, pathExists = (p) => existsSync(path.join(root, p)) } = {}) {
  const problems = []
  const { rows, bad } = parse(text)
  problems.push(...bad)
  const seen = new Set()
  const levels = { 1: 0, 2: 0, 3: 0 }
  for (const r of rows) {
    if (seen.has(r.id)) problems.push(`${r.id}: listed twice`)
    seen.add(r.id)
    levels[r.level] += 1
    if (!STATUSES.includes(r.status)) problems.push(`${r.id}: status "${r.status}" is not one of ${STATUSES.join(', ')}`)
    if (!APPLIES.includes(r.applies)) problems.push(`${r.id}: applies "${r.applies}" is not one of ${APPLIES.join(', ')}`)
    if ((r.status === 'n.a.') !== (r.applies === 'no')) problems.push(`${r.id}: "n.a." and "no" go together`)
    if (!r.evidence) problems.push(`${r.id}: no evidence`)
    if (!r.owner) problems.push(`${r.id}: no owner (use - when nothing is open)`)
    if ((r.status === 'partly' || r.status === 'not met') && r.owner === '-') problems.push(`${r.id}: a gap needs an owner package`)
    if (!r.note) problems.push(`${r.id}: no note`)
    const refs = [...r.evidence.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    if (refs.length === 0) problems.push(`${r.id}: the evidence names no file`)
    for (const ref of refs) if (!pathExists(ref)) problems.push(`${r.id}: evidence path does not exist: ${ref}`)
  }
  if (rows.length !== expected.total) problems.push(`expected ${expected.total} requirements, found ${rows.length}`)
  for (const l of [1, 2, 3]) if (levels[l] !== expected.levels[l]) problems.push(`expected ${expected.levels[l]} level ${l} requirements, found ${levels[l]}`)
  return { problems, rows }
}

const here = path.dirname(fileURLToPath(import.meta.url))
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(here, '..')
  const file = path.join(root, 'docs', 'security', 'asvs-checklist.md')
  if (!existsSync(file)) { console.error('docs/security/asvs-checklist.md is missing'); process.exit(1) }
  const { problems, rows } = check(readFileSync(file, 'utf8'), root)
  if (problems.length) {
    console.error(`ASVS checklist: ${problems.length} problem(s)`)
    for (const p of problems.slice(0, 60)) console.error('  ' + p)
    process.exit(1)
  }
  const count = (s) => rows.filter((r) => r.status === s).length
  console.log(`ASVS checklist ok: ${rows.length} requirements (met ${count('met')}, partly ${count('partly')}, not met ${count('not met')}, n.a. ${count('n.a.')})`)
}
