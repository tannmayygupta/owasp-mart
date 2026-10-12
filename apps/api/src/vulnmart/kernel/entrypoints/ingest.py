"""Ingest entrypoint skeleton (K-06): the instance-event receiver of stream L. Health routes only; no cookies, ever."""
from vulnmart.kernel.service import create_service_app

app = create_service_app("ingest", configure_logs=True)
