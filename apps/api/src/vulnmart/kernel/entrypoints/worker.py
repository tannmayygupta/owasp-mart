"""Worker entrypoint skeleton (K-04): the job worker. A heartbeat loop beside the health routes until P-09 adds Dramatiq."""
from vulnmart.kernel.service import background_lifespan, create_service_app

app = create_service_app("worker", lifespan=background_lifespan("worker"), configure_logs=True)
