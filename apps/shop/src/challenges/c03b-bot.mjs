// C03 part B, the live loop (challenge-specs 3.2 to 3.5): a stored ticket message is opened by the support bot in a browser that runs page scripts.
//
//   queue        one visit job per ticket, a few seconds after it is stored; one at a time; at most 10 visits in 10 minutes; a body over 2 KB is not visited
//   session      the shop mints a signed session for the account `bot.support` (kind "bot") for each visit and hands it to the bot controller; the bot never logs in
//   scope        a bot session may only GET one support ticket page and the agent profile; everything else answers 403 (so the script cannot read orders or case notes)
//   profile      GET /staff/api/agent-profile: the bot session's console key is the flag of C03 in the vulnerable build (the one thing the script is after); any other
//                support agent gets a key of their own that is not a flag; the fixed build hides the key from every script-reachable call
//   listener     /lab/listener (the player's page): the collector address and what the collector has received, so the player can read and paste the flag
//
// The visit happens in both builds (the fixed build escapes the message, so nothing runs and nothing reaches the collector).
import { createHash, randomBytes } from 'node:crypto';
import { serialize } from '../web/session.mjs';
import { isVulnerable } from './mode.mjs';

export const BOT_EMAIL = 'bot.support@vulnmart.test';
export const BOT_DELAY_MS = 3000; // challenge-specs 3.2 gives 10 s as a placeholder; 3 s keeps a player's feedback loop short
export const MAX_VISITS = 10;
export const VISIT_WINDOW_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 2048;
export const BOT_SESSION_TTL_MS = 2 * 60 * 1000;
const DEFAULT_BOT_URL = 'http://bot-controller:9200'; // the contract names the host after the role (instance-contract section 1)

const TICKET_PAGE = /^\/staff\/tickets\/\d+$/;
export const PROFILE_PATH = '/staff/api/agent-profile';

/** Express middleware: a bot session reaches two routes and nothing else. Runs after loadUser, before anything with side effects. */
export function botScope(req, res, next) {
  if (req.session?.kind !== 'bot') return next();
  const path = req.path;
  if (req.method === 'GET' && (TICKET_PAGE.test(path) || path === PROFILE_PATH)) return next();
  return res.status(403).type('text/plain').send('The support bot session cannot open this page.');
}

/** A signed session for the bot account, good for a couple of minutes (the same cookie format as a login). */
export function mintBotSession(db, { now = Date.now() } = {}) {
  const bot = db.prepare('SELECT id FROM users WHERE email = ?').get(BOT_EMAIL);
  if (!bot) return null;
  return serialize({ uid: Number(bot.id), csrf: randomBytes(16).toString('hex'), kind: 'bot', iat: now, exp: now + BOT_SESSION_TTL_MS });
}

/** What GET /staff/api/agent-profile answers for this session (a plain object; the route sends it as JSON). */
export function agentProfile(user, session, { flag, challenges = {} } = {}) {
  const isBot = session?.kind === 'bot' && user.email === BOT_EMAIL;
  let consoleKey;
  if (!isVulnerable('C03B', challenges)) consoleKey = '[hidden]'; // fixed: sensitive values are not handed to scripts through an API the console page can call
  else if (isBot && flag) consoleKey = flag; // the flag of the bot's own profile: only the bot session gets it
  else consoleKey = `ck-${createHash('sha256').update(`console-key:${user.id}`).digest('hex').slice(0, 20)}`; // every other agent: a key of their own, never a flag
  return { agent: user.email.split('@')[0], role: user.role, console_key: consoleKey };
}

async function defaultPost(botUrl, payload, { timeoutMs = 40000 } = {}) {
  try {
    const res = await fetch(new URL('/visit', botUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  } catch { return 0; }
}

/**
 * The visit queue. `enqueue(ticketId, body)` returns what happened to the request: 'queued', or why not ('duplicate', 'too_large', 'rate_limited', 'no_bot').
 * `viewedAt(ticketId)` is the time of the finished visit (ms) or null. Timers never keep the process alive.
 */
export function createBotQueue({ db, botUrl = DEFAULT_BOT_URL, delayMs = BOT_DELAY_MS, post = defaultPost, now = () => Date.now(), enabled = true } = {}) {
  const seen = new Set();
  const viewed = new Map();
  const stamps = [];
  let chain = Promise.resolve();
  function enqueue(ticketId, body) {
    if (!enabled) return 'no_bot';
    const key = String(ticketId);
    if (seen.has(key)) return 'duplicate';
    if (Buffer.byteLength(String(body ?? '')) > MAX_BODY_BYTES) return 'too_large';
    const t = now();
    while (stamps.length && t - stamps[0] > VISIT_WINDOW_MS) stamps.shift();
    if (stamps.length >= MAX_VISITS) return 'rate_limited';
    stamps.push(t);
    seen.add(key);
    chain = chain.then(() => new Promise((resolve) => {
      const timer = setTimeout(async () => {
        try {
          const session = mintBotSession(db);
          if (session && (await post(botUrl, { path: `/staff/tickets/${key}`, session, ticket_id: `t-${key}` })) === 200) viewed.set(key, now());
        } catch { /* a failed visit leaves the ticket unviewed; the player may write another */ }
        resolve();
      }, delayMs);
      timer.unref?.();
    }));
    return 'queued';
  }
  return { enqueue, viewedAt: (ticketId) => viewed.get(String(ticketId)) ?? null, idle: () => chain };
}

/** The collector's id for this instance (the instance id without "i-", lowercase); the collector computes the same. */
export const collectorIdFor = (instanceId) => String(instanceId ?? '').replace(/^i-/, '').toLowerCase();

/** The collector's address as the support agent's browser sees it: port 9104 of the mock-services host unless the URL names a port (tests). */
export function collectorBase(mockUrl = 'http://mock-services') {
  try { const u = new URL(mockUrl); return u.port ? u.origin : `${u.origin}:9104`; } catch { return 'http://mock-services:9104'; }
}

/** What the listener page shows: the collector address inside the instance and its inbox. Best effort; an unreachable collector is an empty inbox. */
export async function readInbox({ mockUrl = 'http://mock-services', fetchImpl = fetch } = {}) {
  const base = collectorBase(mockUrl);
  try {
    const res = await fetchImpl(`${base}/inbox`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { reachable: false, id: null, hits: [] };
    const body = await res.json();
    return { reachable: true, id: body.id ?? null, hits: Array.isArray(body.hits) ? body.hits : [] };
  } catch { return { reachable: false, id: null, hits: [] }; }
}