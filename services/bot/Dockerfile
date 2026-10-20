# VulnMart support-agent bot controller - hardened container image (T-13, FR-SHP-11; C03 part B).
#
# Node program with one dependency (jsdom, pinned in package.json and pnpm-lock.yaml): each visit runs in a child process (visit-worker.mjs) with no environment, a capped heap and
# the Node permission model (read-only access to /app, nothing else). Listens on 9200 on the instance network. Hardening follows the instance contract section 7: non-root uid
# 65532, read-only root filesystem, no added capabilities, writable only on tmpfs. Why jsdom and not a full browser: docs/adr/0058-support-bot-runs-page-scripts-in-jsdom.md.

# ---- builder: install production dependencies (same pinned base and pnpm as apps/shop and services/sidecar) ----
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
WORKDIR /app
RUN npm install -g corepack@0.36.0 \
 && corepack enable \
 && corepack prepare pnpm@12.10.1 --activate
# This package's own lockfile (made with --ignore-workspace, like apps/shop); the repository root lockfile governs the workspace.
COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm install --prod --frozen-lockfile --ignore-workspace

# ---- runtime: distroless non-root Node 24 ----
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production \
    PORT=9200 \
    TZ=UTC
COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

# Explicit non-root for defense-in-depth (don't rely on the caller's --user).
USER 65532:65532

EXPOSE 9200

HEALTHCHECK --interval=2s --timeout=2s --retries=15 --start-period=1s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||9200)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["/app/src/main.mjs"]