"""Story P-11: the fixed-window rate limiter, in memory and against a real Valkey (skipped without VULNMART_TEST_VALKEY_URL)."""
from __future__ import annotations

import os
import threading
import time
import uuid

import pytest

from vulnmart.kernel.ratelimit import InMemoryRateLimiter, RateLimiter, RateLimiterUnavailable, ValkeyRateLimiter, email_key


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_the_limit_is_inclusive_and_the_next_request_waits_for_the_window_end():
    clock = Clock()
    limiter = InMemoryRateLimiter(now=clock)
    assert isinstance(limiter, RateLimiter)
    decisions = [limiter.hit("k", 3, 60) for _ in range(4)]
    assert [d.allowed for d in decisions] == [True, True, True, False]
    assert decisions[3].retry_after == 60
    clock.t += 20
    assert limiter.hit("k", 3, 60).retry_after == 40
    clock.t += 40
    assert limiter.hit("k", 3, 60).allowed, "a new window starts after the old one ends"


def test_keys_are_independent():
    limiter = InMemoryRateLimiter(now=Clock())
    assert limiter.hit("a", 1, 60).allowed and not limiter.hit("a", 1, 60).allowed
    assert limiter.hit("b", 1, 60).allowed


def test_concurrent_hits_never_allow_more_than_the_limit():
    limiter = InMemoryRateLimiter(now=Clock())
    allowed = []
    barrier = threading.Barrier(16)

    def work():
        barrier.wait()
        allowed.append(limiter.hit("k", 5, 60).allowed)

    threads = [threading.Thread(target=work) for _ in range(16)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sum(allowed) == 5


def test_peek_does_not_count_and_denies_only_at_the_limit():
    clock = Clock()
    limiter = InMemoryRateLimiter(now=clock)
    assert limiter.peek("f", 2).allowed, "nothing counted yet"
    limiter.hit("f", 2, 60)
    assert limiter.peek("f", 2).allowed and limiter.peek("f", 2).allowed, "peeking again changes nothing"
    limiter.hit("f", 2, 60)
    denied = limiter.peek("f", 2)
    assert not denied.allowed and denied.retry_after == 60
    clock.t += 61
    assert limiter.peek("f", 2).allowed, "the window ended"


def test_reset_forgets_the_count():
    limiter = InMemoryRateLimiter(now=Clock())
    limiter.hit("f", 1, 60), limiter.hit("f", 1, 60)
    assert not limiter.peek("f", 1).allowed
    limiter.reset("f")
    assert limiter.peek("f", 1).allowed and limiter.hit("f", 1, 60).allowed
    limiter.reset("never-used")  # no error


def test_an_address_is_never_part_of_a_key():
    key = email_key("ada@example.com")
    assert "ada" not in key and "@" not in key and len(key) == 32 and key == email_key("ada@example.com") != email_key("bob@example.com")


def test_a_failing_store_raises_unavailable():
    class Broken:
        def register_script(self, script):
            def call(**kwargs):
                raise ConnectionError("down")
            return call

    with pytest.raises(RateLimiterUnavailable):
        ValkeyRateLimiter(Broken()).hit("k", 1, 60)


VALKEY = os.environ.get("VULNMART_TEST_VALKEY_URL")


@pytest.mark.skipif(not VALKEY, reason="needs VULNMART_TEST_VALKEY_URL")
def test_valkey_counts_expires_and_is_atomic_under_threads():
    import valkey

    client = valkey.Valkey.from_url(VALKEY)
    limiter = ValkeyRateLimiter(client, prefix=f"test:{uuid.uuid4().hex}:")
    first = [limiter.hit("k", 2, 60) for _ in range(3)]
    assert [d.allowed for d in first] == [True, True, False] and 1 <= first[2].retry_after <= 60
    assert client.ttl(limiter._prefix + "k") > 0, "the counter always expires"
    short = ValkeyRateLimiter(client, prefix=f"test:{uuid.uuid4().hex}:")
    assert short.hit("s", 1, 1).allowed and not short.hit("s", 1, 1).allowed
    time.sleep(1.2)
    assert short.hit("s", 1, 1).allowed, "the window ended in Valkey"
    allowed, barrier = [], threading.Barrier(16)

    def work():
        barrier.wait()
        allowed.append(limiter.hit("race", 5, 60).allowed)

    threads = [threading.Thread(target=work) for _ in range(16)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sum(allowed) == 5


def test_a_failing_store_raises_unavailable_for_peek_and_reset():
    class Broken:
        def register_script(self, script):
            return lambda **kw: None

        def pipeline(self):
            raise ConnectionError("down")

        def delete(self, key):
            raise ConnectionError("down")

    limiter = ValkeyRateLimiter(Broken())
    with pytest.raises(RateLimiterUnavailable):
        limiter.peek("k", 1)
    with pytest.raises(RateLimiterUnavailable):
        limiter.reset("k")


@pytest.mark.skipif(not VALKEY, reason="needs VULNMART_TEST_VALKEY_URL")
def test_valkey_peek_and_reset():
    import valkey

    limiter = ValkeyRateLimiter(valkey.Valkey.from_url(VALKEY), prefix=f"test:{uuid.uuid4().hex}:")
    assert limiter.peek("f", 2).allowed
    limiter.hit("f", 2, 60), limiter.hit("f", 2, 60)
    denied = limiter.peek("f", 2)
    assert not denied.allowed and 1 <= denied.retry_after <= 60
    limiter.reset("f")
    assert limiter.peek("f", 2).allowed
