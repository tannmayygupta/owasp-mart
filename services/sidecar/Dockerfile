# VulnMart instance sidecar - hardened container image (story 6.2, task L-20, D-70).
#
# Node program (flag matcher, signed IF-4 events, player-port pass-through that never blocks). Two dependencies only (Ajv, pinned in
# package.json and pnpm-lock.yaml). Hardening follows the instance contract (IF-6 section 7): non-root uid 65532, read-only root
# filesystem, no added capabilities, no-new-privileges, writable only on tmpfs /tmp (the seq state file lives there). No shell.
# Base images are pinned by digest, the same ones as apps/shop and services/bot; update them deliberately, never float a tag.

# ---- builder: install production dependencies ----
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
WORKDIR /app
RUN npm install -g corepack@0.36.0 \
 && corepack enable \
 && corepack prepare pnpm@12.10.1 --activate
# This package's own lockfile (made with --ignore-workspace, like apps/shop); the repository root lockfile governs the workspace.
COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm install --prod --frozen-lockfile --ignore-workspace

# ---- crs-detect: the detection-only Coraza and Core Rule Set helper (story 6.5, D-70). Go is not installed on the dev PC; this stage is the build. ----
# golang:1.25-bookworm, pinned by digest (resolved 2026-10-17). Static binary: no cgo, no libc, trimmed and stripped.
FROM golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS crs-builder
ARG TARGETARCH
WORKDIR /src
COPY crs/go.mod crs/go.sum ./
RUN go mod download && go mod verify
COPY crs/main.go crs/directives.conf ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} go build -trimpath -ldflags "-s -w" -o /out/crs-detect .

# ---- runtime: distroless non-root Node 24 ----
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production \
    TZ=UTC
COPY --from=builder /app/node_modules ./node_modules
COPY schemas ./schemas
COPY src ./src
COPY package.json ./
# The helper the sidecar starts itself (spawn, no shell) on 127.0.0.1:9100. Without this file the sidecar behaves as with --no-crs.
COPY --from=crs-builder /out/crs-detect /app/crs-detect

# Explicit non-root for defense-in-depth (do not rely on the caller's --user).
USER 65532:65532

# 8080 player port (pass-through to the shop), 9000 events from the shop (instance network only).
EXPOSE 8080 9000

# The sidecar listens only after it has read and accepted its start document, so a healthy sidecar is a started one.
# Distroless has no wget or curl: node with the global fetch.
HEALTHCHECK --interval=2s --timeout=2s --retries=15 --start-period=1s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Flags: --no-crs (no detection helper), --relay URL --upstream URL (defaults: the edge relay and the shop of an instance), --state FILE (default /tmp/vm-sidecar-seq.json), --outbox FILE (the durable journal of unsent events, default /tmp/vm-sidecar-outbox.jsonl; /tmp is a tmpfs in the instance template, so the journal survives a restart of the process but not of the container, see ADR 0075).
CMD ["/app/src/main.mjs"]
