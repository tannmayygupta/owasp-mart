# Edge gate service (story edge-2): the gate, the admin listener and the event relay. No dependencies, so no install step.
# Build context is the repository root:  docker build -f apps/edge/Dockerfile -t vulnmart-edge:local .
# Base: node 24.21.0 on Alpine, multi-arch index digest (the same one as contracts/mocks/stub-instance/Dockerfile and infra/caddy/compose.p.yaml).
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY apps/edge/src/ src/
# The saved state (EDGE_STATE_FILE, ADR 0075) lives on a named volume that is mounted here; the folder is created owned by the runtime user so a new volume copies that owner.
RUN mkdir -p /var/lib/vulnmart-edge && chown 65532:65532 /var/lib/vulnmart-edge
ENV NODE_ENV=production
USER 65532:65532
CMD ["node", "/app/src/server.mjs"]
