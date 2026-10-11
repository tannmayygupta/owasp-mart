// The seven shop state machines (T-06, FR-SHP-04 / RS-G 1.1). Pure data and
// functions: no database, no roles. Later stories persist the resulting status
// onto the row and enforce WHO may move a transition (the permission matrix is
// T-07). The status CHECK constraints in migrations/0001_init.sql mirror these
// state lists.

// Each machine: { initial, states:Set, transitions: { from: [to, ...] } }.
function machine(spec) {
  const states = new Set(Object.keys(spec.transitions));
  // Every target is a declared state (terminal states map to []).
  for (const [, tos] of Object.entries(spec.transitions)) {
    for (const to of tos) {
      if (!states.has(to)) throw new Error(`state machine declares transition to unknown state "${to}"`);
    }
  }
  if (!states.has(spec.initial)) throw new Error(`initial state "${spec.initial}" is not a declared state`);
  // Reachability: every non-initial state must be the target of some transition,
  // so a typo'd orphan state cannot slip in silently.
  const reachable = new Set([spec.initial, ...Object.values(spec.transitions).flat()]);
  for (const s of states) {
    if (!reachable.has(s)) throw new Error(`state "${s}" is unreachable (not the initial state and no transition targets it)`);
  }
  return { initial: spec.initial, states, transitions: spec.transitions };
}

export const MACHINES = {
  // Seller onboarding: only an admin moves it (enforced later). Approved and
  // suspended can swap back and forth.
  seller_approval: machine({
    initial: 'pending',
    transitions: {
      pending: ['approved', 'rejected'],
      approved: ['suspended'],
      suspended: ['approved'],
      rejected: [],
    },
  }),

  // Product lifecycle (RS-G). Editing a published title/price sends it back to
  // pending_review (that edit rule is applied by the product flow in T-14).
  // Resubmit-after-reject / relist edges are not in RS-G; add them via a spec
  // update if a flow needs them, not here.
  product: machine({
    initial: 'draft',
    transitions: {
      draft: ['pending_review'],
      pending_review: ['published', 'rejected'],
      published: ['unlisted', 'pending_review'],
      rejected: [],
      unlisted: [],
    },
  }),

  // Checkout flow. The cart and address stages live on the cart; the order row
  // materialises at payment_pending (orders.status CHECK covers only the last
  // three), so this machine is the full logical flow FR-SHP-04 lists.
  checkout: machine({
    initial: 'cart',
    transitions: {
      cart: ['address'],
      address: ['payment_pending'],
      payment_pending: ['paid', 'payment_failed'],
      paid: [],
      payment_failed: [],
    },
  }),

  // Fulfilment, per order item (one order spans many sellers).
  fulfilment: machine({
    initial: 'paid',
    transitions: {
      paid: ['processing', 'cancelled'],
      processing: ['shipped', 'cancelled'],
      shipped: ['delivered'],
      delivered: ['completed'],
      completed: [],
      cancelled: [],
    },
  }),

  refund: machine({
    initial: 'requested',
    transitions: {
      requested: ['approved', 'rejected'],
      approved: ['processed'],
      rejected: [],
      processed: [],
    },
  }),

  dispute: machine({
    initial: 'open',
    transitions: {
      open: ['under_review'],
      under_review: ['resolved_customer', 'resolved_seller', 'escalated'],
      escalated: ['resolved_customer', 'resolved_seller'],
      resolved_customer: [],
      resolved_seller: [],
    },
  }),

  // Payout (RS-G): finance approves; admin can hold at approval. 'held' has no
  // RS-G exit, so it is terminal here (manual resolution comes with a spec update).
  payout: machine({
    initial: 'accrued',
    transitions: {
      accrued: ['ready'],
      ready: ['approved_by_finance'],
      approved_by_finance: ['paid', 'held'],
      held: [],
      paid: [],
    },
  }),
};

export const MACHINE_NAMES = Object.keys(MACHINES);

function get(name) {
  const m = MACHINES[name];
  if (!m) throw new Error(`unknown state machine "${name}"`);
  return m;
}

// True when `to` is a legal next state from `from` in the named machine.
export function canTransition(name, from, to) {
  const m = get(name);
  if (!m.states.has(from)) throw new Error(`${name}: unknown state "${from}"`);
  if (!m.states.has(to)) throw new Error(`${name}: unknown state "${to}"`);
  return m.transitions[from].includes(to);
}

// Return `to` if the transition is legal; otherwise throw naming from/to.
export function assertTransition(name, from, to) {
  if (!canTransition(name, from, to)) {
    throw new Error(`${name}: illegal transition ${from} -> ${to}`);
  }
  return to;
}
