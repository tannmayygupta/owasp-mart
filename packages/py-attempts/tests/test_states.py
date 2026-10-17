import itertools

import pytest

from vulnmart_attempts import (
    CANCELLABLE,
    TRANSITIONS,
    WITHDRAWABLE,
    AttemptState,
    InvalidTransition,
    can_move,
    move,
)

S = AttemptState

# Written out by hand from the diagram of architecture 04 section 10.1 (not derived from TRANSITIONS).
EDGES = {
    ("invited", "consent"), ("consent", "ready"), ("consent", "withdrawn"), ("ready", "running"),
    ("running", "submitted"), ("running", "expired"), ("expired", "submitted"), ("submitted", "reported"),
    ("ready", "cancelled"), ("running", "cancelled"), ("running", "withdrawn"), ("ready", "withdrawn"),
    ("submitted", "withdrawn"), ("invited", "deleted"), ("consent", "deleted"), ("ready", "deleted"),
    ("running", "deleted"), ("submitted", "deleted"), ("reported", "deleted"), ("withdrawn", "deleted"),
    ("cancelled", "deleted"),
}
ALL = [s.value for s in AttemptState]
PAIRS = list(itertools.product(ALL, ALL))


def test_there_are_ten_states_and_no_paused():
    assert len(ALL) == 10
    assert "paused" not in ALL


def test_there_are_one_hundred_pairs_and_twenty_one_edges():
    assert len(PAIRS) == 100
    assert len(EDGES) == 21


@pytest.mark.parametrize(("src", "dst"), PAIRS)
def test_every_pair_matches_the_table(src, dst):
    expected = (src, dst) in EDGES
    assert can_move(src, dst) is expected
    if expected:
        assert move(src, dst) == AttemptState(dst)
    else:
        with pytest.raises(InvalidTransition):
            move(src, dst)


def test_table_equals_the_hand_written_edges():
    assert {(a.value, b.value) for a, bs in TRANSITIONS.items() for b in bs} == EDGES


def test_enum_members_and_strings_both_work():
    assert can_move(S.READY, S.RUNNING)
    assert can_move("ready", S.RUNNING)
    assert move(S.RUNNING, "expired") is S.EXPIRED


@pytest.mark.parametrize("bad", ["paused", "", "READY", "done"])
def test_unknown_state_is_value_error(bad):
    with pytest.raises(ValueError):
        can_move(bad, "ready")
    with pytest.raises(ValueError):
        can_move("ready", bad)
    with pytest.raises(ValueError):
        move("invited", bad)


@pytest.mark.parametrize(
    ("src", "dst"),
    [("invited", "running"), ("invited", "ready"), ("consent", "running"), ("ready", "submitted"),
     ("running", "reported"), ("expired", "reported"), ("submitted", "running"), ("expired", "running")],
)
def test_forbidden_skips_and_reopen(src, dst):
    with pytest.raises(InvalidTransition) as err:
        move(src, dst)
    assert err.value.source == AttemptState(src)
    assert err.value.target == AttemptState(dst)


def test_nothing_leaves_deleted_and_expired_only_goes_to_submitted():
    assert TRANSITIONS[S.DELETED] == frozenset()
    assert TRANSITIONS[S.EXPIRED] == frozenset({S.SUBMITTED})


def test_cancellable_and_withdrawable_sets_agree_with_the_table():
    assert CANCELLABLE == {s for s in S if S.CANCELLED in TRANSITIONS[s]}
    assert WITHDRAWABLE == {s for s in S if S.WITHDRAWN in TRANSITIONS[s]}
    assert CANCELLABLE == {S.READY, S.RUNNING}
    assert WITHDRAWABLE == {S.CONSENT, S.READY, S.RUNNING, S.SUBMITTED}


def test_happy_path_and_expiry_path():
    state = S.INVITED
    for nxt in ("consent", "ready", "running", "submitted", "reported", "deleted"):
        state = move(state, nxt)
    assert state is S.DELETED
    state = S.RUNNING
    for nxt in ("expired", "submitted"):
        state = move(state, nxt)
    assert state is S.SUBMITTED
