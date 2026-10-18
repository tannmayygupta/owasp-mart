// C03 part B — Injection: stored XSS in support ticket messages (OWASP A03/A05,
// CWE-79). A customer's ticket message is shown on the support console; the
// support bot opens it. In the vulnerable build the message is rendered as raw
// HTML, so a <script> in it runs in the agent/bot page; in the fixed build it is
// HTML-escaped and shown as text.
//
// This module owns the ONE rendering decision and the stored-markup detection
// signal. The live exfiltration loop — the headless support bot opening the
// ticket, the script reading the bot's agent-profile token, and the in-instance
// collector receiving it — is the bot browser's job (deferred to the bot
// headless-visitor work, S-5 / H-44); see deferred-work.md.
import { isVulnerable } from './mode.mjs';

const TAG = /<[a-z][\s\S]*>/i; // a crude "contains an HTML tag" check for the signal

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// How the support console renders a ticket message body. FIXED escapes it;
// VULNERABLE returns it as-is (the stored XSS). Returns a plain string either way;
// the view inserts it without re-escaping (the one deliberate `| safe` spot).
export function renderTicketMessageHtml(body, { challenges = {} } = {}) {
  if (isVulnerable('C03B', challenges)) return String(body ?? '');
  return escapeHtml(body ?? '');
}

// Call when a ticket message is stored, to emit the part-B M1 signal if the
// message carries an HTML tag. Correct storage is unchanged — the shop stores the
// raw text as data in both builds; only the RENDER differs.
export function noteTicketMarkup(body, { challenges = {}, emit = () => {}, ticketId, messageId, userId } = {}) {
  if (TAG.test(String(body ?? ''))) {
    emit('shop.ticket_markup_stored', {
      ticket_id: ticketId != null ? String(ticketId) : null,
      message_id: messageId != null ? String(messageId) : null,
      user_id: userId != null ? String(userId) : null,
    });
  }
}
