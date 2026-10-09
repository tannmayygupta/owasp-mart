# VulnMart target shop — hardened container image (T-01 tracer bullet).
#
# Hardening follows the instance contract (contracts/instance/instance-contract.md
# section 7) and the hello container pattern (infra/compose/compose.yaml):
# non-root uid 65532, read-only root filesystem, no added capabilities,
# no-new-privileges, writable only on tmpfs. Run flags live in the dev-log.
#
# Base images are pinned by digest. The digests below were captured with
# `docker buildx imagetools inspect` / `docker inspect` on 2026-10-09 and are
# recorded in the dev-log. Update them deliberately, never float the tag.

# ---- builder: install production dependencies ----
# Base matches the repo's Node pin (.node-version 24.21.0).
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
WORKDIR /app
# The slim image ships an older corepack whose pnpm shim is broken for pnpm 12
# (looks for pnpm.cjs, the package now ships pnpm.mjs). Upgrade corepack and pin
# pnpm 12.10.1 (the repo's packageManager) before installing.
RUN npm install -g corepack@0.36.0 \
 && corepack enable \
 && corepack prepare pnpm@12.10.1 --activate
# Copy the manifest and the shop's own lockfile so the install is reproducible.
# apps/shop/pnpm-lock.yaml is generated with --ignore-workspace and is only used
# here; the repo-root lockfile governs the workspace itself.
COPY package.json pnpm-lock.yaml ./
# Isolated, frozen single-package install (no workspace file in the build context).
RUN corepack pnpm install --prod --frozen-lockfile --ignore-workspace

# ---- runtime: distroless non-root Node 24 ----
# Distroless runs as uid:gid 65532:65532 (nonroot) and has no shell, which fits a
# read-only root filesystem and cap_drop ALL. Its ENTRYPOINT is /nodejs/bin/node
# (node is not on PATH and there is no shell), so CMD and HEALTHCHECK spell it out.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=UTC
COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

EXPOSE 3000

# Docker's own healthcheck hits /readyz (instance contract section 6). Distroless
# has no wget/curl, so use node with the global fetch (Node 24).
HEALTHCHECK --interval=2s --timeout=2s --retries=15 --start-period=1s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT ?? 3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["/app/src/server.mjs"]
