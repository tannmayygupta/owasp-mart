"""Scheduler entrypoint skeleton (K-05): the leader-elected loop that enqueues jobs and writes `job_runs`. A heartbeat
loop beside the health routes until its story adds the jobs and the advisory-lock election."""
from vulnmart.kernel.service import background_lifespan, create_service_app

app = create_service_app("scheduler", lifespan=background_lifespan("scheduler"), configure_logs=True)
