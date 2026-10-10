#!/usr/bin/env python3
"""Keep-alive load for an Oracle Always Free Arm VM.

Oracle treats a VM as idle when CPU (95th percentile), network and (Arm only) memory are all under 20 percent
for 7 days. One measure above 20 percent is enough, so this holds a modest, bounded amount of memory
(default 1536 MB of 6 GB, about 25 percent). CPU load is off by default and is the fallback.
Settings come from environment variables and are clamped; the systemd unit adds hard limits on top.
  KEEPALIVE_MEM_MB        default 1536, allowed 0 to 1900
  KEEPALIVE_CPU_PERCENT   default 0, allowed 0 to 40 (share of one core)
  --check                 print the settings and exit
"""
import os
import signal
import sys
import time

MAX_MEM_MB = 1900  # clearly below the unit MemoryMax=2200M (interpreter and buffers need headroom)
MAX_CPU_PERCENT = 40


def clamp(value, low, high):
    return max(low, min(high, value))


def int_env(name, default):
    """A value that is not a whole number falls back to the default with a warning (no crash loop)."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"keepalive warning: {name}={raw!r} is not a whole number, using {default}", file=sys.stderr, flush=True)
        return default


def settings():
    mem = clamp(int_env("KEEPALIVE_MEM_MB", 1536), 0, MAX_MEM_MB)
    cpu = clamp(int_env("KEEPALIVE_CPU_PERCENT", 0), 0, MAX_CPU_PERCENT)
    return mem, cpu


def touch(buf):
    for i in range(0, len(buf), 4096):
        buf[i] = 1


def main():
    mem_mb, cpu = settings()
    print(f"keepalive mem_mb={mem_mb} cpu_percent={cpu}", flush=True)
    if "--check" in sys.argv:
        return 0
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    buf = bytearray(mem_mb * 1024 * 1024)
    last_touch = 0.0
    while True:
        now = time.monotonic()
        if now - last_touch >= 60:  # keep the pages resident
            touch(buf)
            last_touch = now
        if cpu > 0:
            end = now + cpu / 100.0
            while time.monotonic() < end:
                pass
            time.sleep(1 - cpu / 100.0)
        else:
            time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
