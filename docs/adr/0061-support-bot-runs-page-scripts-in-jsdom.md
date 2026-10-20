# 0061. The support bot runs page scripts in jsdom, one child process per visit

- **Status:** Proposed. Implemented and tested; it is not in `initial.md` Section 15 until the developer confirms it (CLAUDE.md working rule 1).
- **Date:** 2026-10-20
- **Deciders:** Tanmay (developer), implemented with Claude Code
- **Requirements:** C03 part B (stored XSS with a bot victim), FR-SHP-11, FR-CHL-04, challenge-specs 3.2 to 3.7, spike S-5 (browser memory), D-18, instance contract IF-6 (components, env names), D-76 (event sources)

## Context
C03 part B needs a victim: a support agent whose browser opens the player's ticket and runs the script the player stored. The bot controller until now only did an HTTP GET, which never runs page scripts, so the challenge could be shown only as "the markup is stored and rendered raw". The platform needs the real loop: the script runs, reads the agent's profile with the bot's session, sends it to a collector, and the player reads the flag there.

Limits that decide the choice: seven instances share one 8 GB host (the demo template gives the bot 128 MB), every instance container runs in gVisor, the image must stay small and distroless, and the player's script is hostile by design.

## Options considered
1. **Headless Chromium (Playwright or Puppeteer).** Real browser, real `onerror`/`onload`/navigation behaviour. Needs a Debian-based image (about 400 MB more), 300 MB or more of memory per visit, and a sandbox (user namespaces or `--no-sandbox`) that is awkward inside gVisor. At the demo sizes it takes the host from seven instances to about three.
2. **jsdom in a child process per visit (chosen).** One pinned npm dependency (jsdom 28.1.0), about 70 to 90 MB per visit measured, runs inside the existing distroless image, executes inline scripts, event-handler attributes, fetch/XHR shims, cookies and timers. It is not a browser: it does not run image loading, navigation or CSS layout.
3. **Regex "does the message look like XSS" check.** No script runs, nothing exfiltrates; the loop cannot be shown. Rejected.

## Decision
Option 2. What is built around its gaps:
- **Fidelity.** The visit emulates what a support agent's browser does to a ticket page: images in the HTML are requested (a missing image fires `error`), media and frames fire `load`, an `autofocus` field takes the focus, `details[open]` toggles, and elements that carry pointer or focus handlers (and `javascript:` links) get mouse and focus events. Not emulated: navigation (`location = ...`), `window.open`, WebSocket, service workers. The hints name `fetch` and `Image`, which work.
- **Network layer (challenge-specs 3.7).** Every request of the page, including those jsdom makes itself, goes through one function that allows only the shop's origin and the collector's origin, adds the visit tag `x-vm-visit` (set last, so the page cannot replace it), adds the bot's cookie for the shop only, and caps requests (60), body (64 KB) and answer (256 KB) sizes. The session cookie is HttpOnly, so `document.cookie` does not show it.
- **Process isolation.** Each visit runs in a forked child with an empty environment, a heap limit of 72 MB, the Node permission model (`--permission`, read access to `/app` only: no writes, no child processes, no workers) and a hard time limit with SIGKILL, so `while(true){}` cannot hang the controller. One visit at a time per instance.
- **Closing the climb into the process.** jsdom's own functions (`setTimeout`, `createElement`, `addEventListener`) belong to the worker's realm, so `setTimeout.constructor('return process')()` reached the worker's `process` (found by the test probe, then fixed). The worker now makes `.constructor` of every function prototype answer `undefined` and locks `Error.prepareStackTrace`, and the page's `console`, `fetch`, XHR, `WebSocket` and `window.open` are replaced by in-page code that talks to the bridge with strings only. Test: `services/bot/test/browser.test.mjs` "cannot climb".
- **This is defence in depth, not a boundary.** jsdom documents that it is not a security sandbox. The boundary is the container: non-root, read-only root, no capabilities, gVisor, no secret in it, the instance network only. A page that did escape would reach the instance's own services (sidecar event port, mock-services), which the player could already influence only through their own instance.
- **Shop side.** The shop mints a signed session for the seeded account `bot.support` with `kind: "bot"` for each visit and hands it to the controller; a bot session may only `GET` one support ticket page and `/staff/api/agent-profile` (403 elsewhere). The agent profile returns the flag as `console_key` to the bot session in the vulnerable build only; other support agents get a key of their own; the fixed build hides the key from every script-reachable call.
- **Collector.** `/c/<id>` records a hit (id check, tag check, at most 20 kept), answers a 1x1 GIF with open CORS and reports `collector.hit` (ids and counts, never content) to the sidecar. The player reads the result on `/lab/listener`.

## Consequences
- The bot image grows from 203 MB to 233 MB; a visit takes about 6 s of start-up plus the 5 s the agent keeps the ticket open (measured at 0.5 CPU in the hardened container).
- Memory at the demo size: measured peak 81 to 92 MiB inside a 128 MB container, so the demo template keeps 128 MB. A payload that allocates heavily is stopped by the 72 MB heap limit of the child.
- Payloads that rely on real navigation do not work in the lab; the write-up says so.
- Switching to a real browser later only replaces `browser.mjs`: the controller, the shop and the collector do not change.

## Evidence
- jsdom README, section on `resources`, `requestInterceptor` and the warning about running untrusted scripts (installed copy `services/bot/node_modules/jsdom/README.md`, version 28.1.0).
- Node permission model: https://nodejs.org/docs/latest-v24.x/api/permissions.html (not re-read in this session: the flags `--permission` and `--allow-fs-read` were tested directly in the distroless image, and the page cannot reach any file API anyway).
- Measured in this session: hardened container run (`--read-only --cap-drop=ALL --memory=128m --cpus=0.5 --pids-limit=64`), see the dev-log of this task.