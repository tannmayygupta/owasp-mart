// State-machine tests (T-06, FR-SHP-04): for all seven machines a legal path is
// allowed and representative illegal transitions are rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MACHINES,
  MACHINE_NAMES,
  canTransition,
  assertTransition,
} from '../src/domain/state-machines.mjs';

test('there are exactly seven state machines', () => {
  assert.equal(MACHINE_NAMES.length, 7);
  assert.deepEqual(
    MACHINE_NAMES.sort(),
    ['checkout', 'dispute', 'fulfilment', 'payout', 'product', 'refund', 'seller_approval'],
  );
});

// Legal transitions that must be allowed, one representative per machine.
const LEGAL = [
  ['seller_approval', 'pending', 'approved'],
  ['seller_approval', 'approved', 'suspended'],
  ['seller_approval', 'suspended', 'approved'],
  ['product', 'draft', 'pending_review'],
  ['product', 'pending_review', 'published'],
  ['product', 'published', 'pending_review'],
  ['checkout', 'payment_pending', 'paid'],
  ['fulfilment', 'paid', 'processing'],
  ['fulfilment', 'processing', 'cancelled'],
  ['fulfilment', 'shipped', 'delivered'],
  ['refund', 'requested', 'approved'],
  ['refund', 'approved', 'processed'],
  ['dispute', 'open', 'under_review'],
  ['dispute', 'under_review', 'escalated'],
  ['payout', 'accrued', 'ready'],
  ['payout', 'approved_by_finance', 'paid'],
];

// Illegal transitions that must be rejected (skipping states / going backwards,
// and the recovery edges RS-G does not sanction).
const ILLEGAL = [
  ['seller_approval', 'pending', 'suspended'],
  ['seller_approval', 'rejected', 'approved'],
  ['product', 'draft', 'published'],
  ['product', 'rejected', 'pending_review'],
  ['product', 'unlisted', 'pending_review'],
  ['checkout', 'payment_pending', 'cart'],
  ['checkout', 'payment_failed', 'payment_pending'],
  ['fulfilment', 'paid', 'shipped'],
  ['fulfilment', 'shipped', 'cancelled'],
  ['refund', 'requested', 'processed'],
  ['dispute', 'open', 'resolved_customer'],
  ['payout', 'accrued', 'paid'],
  ['payout', 'paid', 'ready'],
  ['payout', 'ready', 'held'],
  ['payout', 'held', 'ready'],
];

test('legal transitions are allowed', () => {
  for (const [m, from, to] of LEGAL) {
    assert.equal(canTransition(m, from, to), true, `${m}: ${from} -> ${to} should be legal`);
    assert.equal(assertTransition(m, from, to), to);
  }
});

test('illegal transitions are rejected naming from/to', () => {
  for (const [m, from, to] of ILLEGAL) {
    assert.equal(canTransition(m, from, to), false, `${m}: ${from} -> ${to} should be illegal`);
    assert.throws(() => assertTransition(m, from, to), new RegExp(`${m}: illegal transition ${from} -> ${to}`));
  }
});

test('unknown machine or state throws', () => {
  assert.throws(() => canTransition('nope', 'a', 'b'), /unknown state machine/);
  assert.throws(() => canTransition('refund', 'bogus', 'approved'), /unknown state/);
  assert.throws(() => canTransition('refund', 'requested', 'bogus'), /unknown state/);
});

test('only the declared edges are legal — every other state pair is rejected', () => {
  for (const name of MACHINE_NAMES) {
    const m = MACHINES[name];
    const states = [...m.states];
    for (const from of states) {
      for (const to of states) {
        const declared = m.transitions[from].includes(to);
        assert.equal(
          canTransition(name, from, to),
          declared,
          `${name}: ${from} -> ${to} should be ${declared ? 'legal' : 'rejected'}`,
        );
      }
    }
  }
});

test('no machine has an orphan (unreachable) state', () => {
  // machine() throws on construction for an orphan; assert the live machines hold.
  for (const name of MACHINE_NAMES) {
    const m = MACHINES[name];
    const reachable = new Set([m.initial, ...Object.values(m.transitions).flat()]);
    for (const s of m.states) assert.ok(reachable.has(s), `${name}: ${s} must be reachable`);
  }
});

test('every machine has a reachable initial state and consistent targets', () => {
  for (const name of MACHINE_NAMES) {
    const m = MACHINES[name];
    assert.ok(m.states.has(m.initial), `${name} initial is a state`);
    for (const [, tos] of Object.entries(m.transitions)) {
      for (const to of tos) assert.ok(m.states.has(to), `${name} target ${to} is a state`);
    }
  }
});
