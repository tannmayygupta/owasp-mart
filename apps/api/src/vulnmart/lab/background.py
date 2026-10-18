"""The tick of the lab runtime as a lifespan of the API process: engine steps, milestone timers, held-capture reminders (stream L).

One loop per process. Two processes may tick the same database: the engine's compare-and-set means a step is done once.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from vulnmart.lab.runtime import LabRuntime

log = logging.getLogger("vulnmart.lab.background")
TICK_SECONDS = 10.0


def lab_lifespan(runtime: LabRuntime, interval_s: float = TICK_SECONDS):
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        stop = asyncio.Event()

        async def loop() -> None:
            while not stop.is_set():
                try:
                    await asyncio.to_thread(runtime.tick)
                except Exception:  # a failed tick is tried again at the next one
                    log.exception("lab tick failed")
                try:
                    await asyncio.wait_for(stop.wait(), interval_s)
                except asyncio.TimeoutError:
                    pass

        task = asyncio.create_task(loop())
        app.state.lab_tick_task = task
        log.info("lab tick started (every %.0f s)", interval_s)
        try:
            yield
        finally:
            stop.set()
            await task

    return lifespan
