"""Ingest entrypoint skeleton (K-06): the instance-event receiver of stream L. Health routes only; no cookies, ever.

With `VULNMART_LAB_RUNTIME=1` the lab runtime (story 8.1) is built and its ingest handler serves the event route; with
`VULNMART_LAB_DEMO=1` and a non-empty `VULNMART_LAB_DEMO_TOKEN` the token-guarded demo routes are mounted as well. With the
variables unset this file behaves as before."""
import os

from vulnmart.ingest.route import install_event_route
from vulnmart.kernel.service import create_service_app

app = create_service_app("ingest", configure_logs=True)
install_event_route(app)

if os.environ.get("VULNMART_LAB_RUNTIME") == "1":
    from vulnmart.lab.runtime import build_lab_runtime  # lazily: the off path imports nothing new

    _runtime = build_lab_runtime(os.environ)
    app.state.ingest_handler = _runtime.handler
    app.state.lab = _runtime
    if os.environ.get("VULNMART_LAB_DEMO") == "1":
        from vulnmart.lab.demo_routes import install_demo_routes

        install_demo_routes(app, _runtime, os.environ.get("VULNMART_LAB_DEMO_TOKEN", ""))
