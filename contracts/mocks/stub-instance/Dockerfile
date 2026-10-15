# Stub instance image (story L-06). TEST ONLY: never a product image, never pushed.
# Build context is the repository root:  docker build -f contracts/mocks/stub-instance/Dockerfile .
# Base: node 24.21.0 on Alpine, multi-arch index digest checked on 2026-10-10 (matches .node-version 24.21.0).
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
# The only dependencies, pinned exactly as in the root package.json (the fake ingest and the schema checks need Ajv; the fake ingest builds its IF-8 error bodies with js-yaml from the registry).
RUN npm install --no-audit --no-fund --no-package-lock --ignore-scripts ajv@8.20.0 ajv-formats@3.0.1 js-yaml@4.1.0 \
 && npm cache clean --force
COPY contracts/mocks/fake-ingest/ contracts/mocks/fake-ingest/
COPY contracts/mocks/shared/ contracts/mocks/shared/
COPY contracts/errors/error-codes.yaml contracts/errors/error-codes.yaml
COPY contracts/mocks/stub-instance/ contracts/mocks/stub-instance/
COPY contracts/events/instance-events.schema.json contracts/events/instance-events.posted.schema.json contracts/events/
COPY contracts/instance/injection-document.schema.json contracts/instance/flags-file.schema.json contracts/instance/sidecar-start.schema.json contracts/instance/
USER 65532:65532
ENTRYPOINT ["node", "/app/contracts/mocks/stub-instance/main.mjs"]
