# VulnMart platform API image (story 1.1; story 1.6 adds the migrations and the entrypoints).
# Build context is the REPOSITORY ROOT (the uv workspace lockfile lives there):
#   docker build -f apps/api/Dockerfile .
# Compose does this for you (infra/compose/compose.yaml).
#
# Base images are pinned by digest, captured with `docker buildx imagetools inspect`
# on 2026-10-11. Update them deliberately, never float the tag.

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
# Dependencies first (cached until a manifest or the lockfile changes).
COPY pyproject.toml uv.lock .python-version ./
COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY packages/py-models/pyproject.toml packages/py-models/pyproject.toml
COPY packages/py-attempts/pyproject.toml packages/py-attempts/pyproject.toml
RUN uv sync --frozen --no-dev --no-editable --package vulnmart-api --no-install-workspace
# Then the application code.
COPY packages/py-models/src packages/py-models/src
COPY packages/py-attempts/src packages/py-attempts/src
COPY apps/api/src apps/api/src
RUN uv sync --frozen --no-dev --no-editable --package vulnmart-api

# ---- runtime: same Python, non-root, no uv, no build tools ----
FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
COPY --from=builder /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=UTC
WORKDIR /app
# What /version answers (NFR-OBS-02): passed by the build (Compose sets them from VULNMART_VERSION and VULNMART_COMMIT).
ARG VULNMART_VERSION=0.0.0-dev
ARG VULNMART_COMMIT=unknown
ENV VULNMART_VERSION=$VULNMART_VERSION \
    VULNMART_COMMIT=$VULNMART_COMMIT
# The one Alembic history: the Compose `migrate` service runs `alembic -c /app/alembic.ini upgrade head`.
COPY apps/api/alembic.ini /app/alembic.ini
COPY apps/api/migrations /app/migrations
# The IF-4 event schema the ingest handler validates against (the default path points at the repository root, absent here).
COPY contracts/events/instance-events.schema.json /app/contracts/events/instance-events.schema.json
ENV VULNMART_EVENT_SCHEMA=/app/contracts/events/instance-events.schema.json
USER 65532:65532
EXPOSE 8000

# Docker's own healthcheck: healthy when /readyz answers 200 (Postgres and Valkey ready), so services that depend on
# the API start after it is ready. /healthz is the liveness route (the process answers).
HEALTHCHECK --interval=2s --timeout=4s --retries=15 --start-period=2s \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=3).status == 200 else 1)"]

# The API. The other entrypoints use the same image: uvicorn vulnmart.kernel.entrypoints.<ingest|live|worker|scheduler>:app
CMD ["uvicorn", "vulnmart.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
