#!/usr/bin/env node
// Documentation gate for VulnMart. Blocks a commit when code changed but the task was not documented.
//
// Two ways it runs:
//   1) Claude Code hook (PreToolUse on Bash):  node scripts/check-docs.mjs --claude-hook   (reads JSON on stdin)
//   2) Git commit-msg hook (backstop):         node scripts/check-docs.mjs --git <commit-msg-file>
//
// Rule: if any non-exempt file changes, the same commit must also add/modify
//   - a dev-log entry:  docs/dev-log/<anything>.md  (not README / _TEMPLATE)
//   - CHANGELOG.md
// Bypass for non-functional commits (formatting, typos): put [no-doc] in the commit message.
// If anything unexpected goes wrong, the script lets the commit through (fails open) so it never traps a developer.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXEMPT = [
  /^docs\//,
  /^\.claude\//,
  /^\.githooks\//,
  /^scripts\/check-docs\.mjs$/,
  /^[^/]+\.md$/, // root-level markdown (README, CLAUDE.md, initial.md, CHANGELOG.md)
  /^\.gitignore$/,
  /^LICENSE/,
];
const isDevLog = (f) => /^docs\/dev-log\/.+\.md$/.test(f) && !/\/(README|_TEMPLATE)\.md$/.test(f);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Files with changes in the working tree (tracked or untracked), optionally limited to some paths.
function gitStatus(cwd, paths = []) {
  const args = ['status', '--porcelain', '-uall', ...(paths.length ? ['--', ...paths] : [])];
  const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
    .map((p) => p.replace(/^"|"$/g, ''));
}

function evaluate(files, message) {
  if (/\[no-doc\]/i.test(message)) return null;
  if (/^(Merge|Revert) /.test(message.trim())) return null;
  const code = files.filter((f) => !EXEMPT.some((re) => re.test(f)));
  if (code.length === 0) return null;
  const missing = [];
  if (!files.some(isDevLog)) missing.push('a dev-log entry (docs/dev-log/YYYY-MM-DD-<dev>-<task-slug>.md from docs/dev-log/_TEMPLATE.md)');
  if (!files.includes('CHANGELOG.md')) missing.push('a CHANGELOG.md line under [Unreleased]');
  if (missing.length === 0) return null;
  const shown = code.slice(0, 5).join(', ') + (code.length > 5 ? `, +${code.length - 5} more` : '');
  return (
    `Documentation rule (see CLAUDE.md): code changed (${shown}) but this commit is missing ${missing.join(' and ')}. ` +
    `Write them from the real work done (also update docs/traceability.md, and add docs/adr/NNNN-*.md if a decision was made), ` +
    `git add them, then retry the commit. If anything is unclear, ask the developer instead of guessing. ` +
    `For purely non-functional commits (formatting, typos) add [no-doc] to the commit message.`
  );
}

try {
  if (process.argv.includes('--claude-hook')) {
    const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}');
    const command = input?.tool_input?.command ?? '';
    const m = command.match(/\bgit\s+((?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?)commit\b/);
    if (input?.tool_name !== 'Bash' || !m) process.exit(0);
    let cwd = input.cwd || process.cwd();
    const c = m[1].match(/-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if (c) cwd = c[1] || c[2] || c[3];
    const files = new Set(git(['diff', '--cached', '--name-only'], cwd));
    // `git commit -a` / `-am` stages tracked changes at commit time, so count them too.
    if (/\s(--all|-[a-zA-Z]*a[a-zA-Z]*)(\s|$)/.test(command.slice(m.index))) {
      git(['diff', '--name-only'], cwd).forEach((f) => files.add(f));
    }
    // Chained `git add ... && git commit`: the add has not run yet when this hook runs, so read it from the command.
    for (const a of command.slice(0, m.index).matchAll(/\bgit\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?add\b([^&;|]*)/g)) {
      const args = a[1].trim().split(/\s+/).filter(Boolean);
      const flags = args.filter((x) => x.startsWith('-'));
      const paths = args.filter((x) => !x.startsWith('-')).map((x) => x.replace(/^["']|["']$/g, ''));
      const everything = flags.some((f) => /^(-A|--all)$/.test(f)) || paths.some((p) => ['.', ':/', '*'].includes(p));
      const tracked = flags.some((f) => /^(-u|--update)$/.test(f));
      const added = everything ? gitStatus(cwd) : tracked ? git(['diff', '--name-only'], cwd) : paths.length ? gitStatus(cwd, paths) : [];
      added.forEach((f) => files.add(f));
    }
    const reason = evaluate([...files], command);
    if (reason) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
        }),
      );
    }
    process.exit(0);
  } else {
    // git commit-msg backstop
    const msgFile = process.argv[process.argv.indexOf('--git') + 1];
    const message = msgFile ? readFileSync(msgFile, 'utf8') : '';
    const files = git(['diff', '--cached', '--name-only'], process.cwd());
    const reason = evaluate(files, message);
    if (reason) {
      console.error(`\n${reason}\n`);
      process.exit(1);
    }
    process.exit(0);
  }
} catch (e) {
  process.stderr.write(`check-docs: skipped because of an internal error: ${e.message}\n`); // debug log only
  process.exit(0); // fail open
}
