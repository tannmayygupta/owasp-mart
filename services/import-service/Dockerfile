# VulnMart import-service — hardened container image (T-12, FR-SHP-13).
#
# Node built-ins only (no dependency install stage). Runs network_mode none with
# no /data mount (set by the instance template/runtime), so the service has no
# network and no database access. Each job runs in a fresh child process.
# Hardening follows the instance contract section 7: non-root uid 65532,
# read-only root filesystem, no added capabilities, writable only on tmpfs.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production \
    TZ=UTC \
    VM_IMPORT_SOCKET=/run/import/import.sock
COPY src ./src
COPY package.json ./

# Explicit non-root (don't rely on the caller's --user) for defense-in-depth.
USER 65532:65532

# No network, so the healthcheck is a socket connect (kind "socket"), not HTTP.
HEALTHCHECK --interval=2s --timeout=2s --retries=15 --start-period=1s \
  CMD ["/nodejs/bin/node", "-e", "require('net').connect(process.env.VM_IMPORT_SOCKET).on('connect',function(){this.end();process.exit(0)}).on('error',()=>process.exit(1))"]

CMD ["/app/src/main.mjs"]
