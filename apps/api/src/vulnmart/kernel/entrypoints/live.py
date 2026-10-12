"""Live hub entrypoint skeleton (K-07, ADR 0006): the SSE hub. Health routes only until P-22."""
from vulnmart.kernel.service import create_service_app

app = create_service_app("live", configure_logs=True)
