"""The skeleton entrypoints of the codebase besides the API (architecture 01 section 2): ingest, live hub, worker, scheduler.

Each is `uvicorn vulnmart.kernel.entrypoints.<name>:app` and answers `/healthz`, `/readyz` and `/version` only, until its
story gives it work (ingest and live: stream L and P-22; worker: P-09; scheduler: P-24). They join Compose with those stories.
"""
