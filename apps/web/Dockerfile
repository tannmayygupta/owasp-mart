# VulnMart dashboards, DEV-SERVER image (story 1.1 tracer bullet).
# Compose bind-mounts apps/web over /app and puts node_modules and .next in named volumes
# (infra/compose/compose.yaml, profile "web"). The image only supplies Node, pnpm and a first
# dependency install, so a fresh named volume starts populated.
#
# Base image is pinned by digest (same Node as .node-version 24.21.0 and apps/shop), captured with
# `docker buildx imagetools inspect` on 2026-10-11. Update it deliberately, never float the tag.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# pnpm 12.10.1 is the repo's packageManager. The slim image's corepack cannot run pnpm 12, so install
# it directly (npm) as root; the app itself runs as the unprivileged uid below.
RUN npm install -g pnpm@12.10.1

# HOME is a throwaway tmpfs-friendly path; the pnpm store lives inside the node_modules volume.
ENV HOME=/tmp \
    npm_config_store_dir=/app/node_modules/.pnpm-store \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=UTC

# A named volume copies the ownership of the image directory it is first mounted on, so create the
# two volume targets owned by the runtime uid.
RUN mkdir -p /app/node_modules /app/.next && chown -R 65532:65532 /app
WORKDIR /app
USER 65532:65532

# This app has its own lockfile (apps/web/pnpm-lock.yaml), installed in isolation as apps/shop does.
COPY --chown=65532:65532 package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace

EXPOSE 3000

# Re-run the (fast, frozen) install on start so a changed lockfile is picked up, then the dev server.
CMD ["sh", "-c", "pnpm install --frozen-lockfile --ignore-workspace && exec pnpm dev --hostname 0.0.0.0 --port 3000"]
