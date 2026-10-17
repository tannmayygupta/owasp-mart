# VulnMart orchestrator service image (story 3.2, D10). Same pattern as apps/api/Dockerfile.
# Build context is the REPOSITORY ROOT (the uv workspace lockfile lives there):
#   docker build -f apps/orchestrator/Dockerfile .
# The compose service `orchestrator` (profile lab, infra/compose/compose.yaml, edge story 6) runs this image on the labs-core network with the socket
# proxy as Docker host. At run time the service needs, from
# the operator and never from the image: the two signing keys (environment variables VM_ORCH_PLATFORM_KEY and VM_ORCH_REPORT_KEY, or the
# files --key-file and --report-key-file with mode 0600; there is no key option on the command line, it would show in `ps`), the template folder
# (--templates-dir), the release manifest of image digests (--images-manifest), the three TLS files (--tls-cert, --tls-key, --tls-ca)
# and the Docker API address (--docker-host, a socket proxy that allows only what the engine needs).
#
# TLS is required: the image listens on 0.0.0.0, and the service refuses to start on a non-loopback address without the three TLS files
# (exit 2). `--insecure-no-tls` exists for tests and the local demo only and is never part of this image. `--backend fake` is refused
# unless `--allow-fake-backend` is given; this image never sets it, and the default backend is docker.
#
# Base images are pinned by digest, the same ones as the API image (captured with `docker buildx imagetools inspect` on 2026-10-11).
# Update them deliberately, never float the tag.

# uv 0.12.23 (the repo's pin, see ci.yml), copied in as a binary only.
FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv

# ---- builder: install locked production dependencies into a venv ----
FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
# Dependencies first (cached until a manifest or the lockfile changes). Every workspace member needs its manifest for `--frozen`.
COPY pyproject.toml uv.lock .python-version ./
COPY apps/orchestrator/pyproject.toml apps/orchestrator/pyproject.toml
COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY packages/py-models/pyproject.toml packages/py-models/pyproject.toml
RUN uv sync --frozen --no-dev --no-editable --package vulnmart-orchestrator --no-install-workspace
# Then the application code (the shared error registry constants of IF-8 come from packages/py-models).
COPY packages/py-models/src packages/py-models/src
COPY apps/orchestrator/src apps/orchestrator/src
RUN uv sync --frozen --no-dev --no-editable --package vulnmart-orchestrator

# ---- runtime: same Python, non-root, no uv, no build tools ----
FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
COPY --from=builder /opt/venv /opt/venv
# The template schema the service checks every template against at start (the templates themselves come from the operator).
COPY contracts/instance/instance-template.schema.json /app/contracts/instance/instance-template.schema.json
# The folder for --state-dir (tombstones of destroyed ids). A named volume mounted here takes this owner on first use (compose service `orchestrator`).
RUN mkdir -p /var/lib/vulnmart/orchestrator && chown 65532:65532 /var/lib/vulnmart/orchestrator
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=UTC
WORKDIR /app
USER 65532:65532
EXPOSE 8443

# Every API call is signed, so there is no anonymous health URL; Docker's check is that the port accepts a connection.
HEALTHCHECK --interval=5s --timeout=4s --retries=6 --start-period=3s \
  CMD ["python", "-c", "import socket; socket.create_connection(('127.0.0.1', 8443), timeout=3).close()"]

ENTRYPOINT ["python", "-m", "vulnmart_orchestrator", "--host", "0.0.0.0", "--port", "8443", "--template-schema", "/app/contracts/instance/instance-template.schema.json"]
CMD ["--templates-dir", "/etc/vulnmart/templates"]
