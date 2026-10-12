# VulnMart mock-services — hardened container image (T-11, FR-SHP-13).
#
# Node built-ins only, so there is no dependency install stage. Hardening follows
# the instance contract (contracts/instance/instance-contract.md section 7):
# non-root uid 65532, read-only root filesystem, no added capabilities,
# no-new-privileges (set by the instance template/runtime), writable only on
# tmpfs. The four services listen on 9101-9104 inside the instance network only.
#
# Distroless runs as uid:gid 65532:65532 (nonroot), has no shell, and its
# ENTRYPOINT is /nodejs/bin/node, so CMD and HEALTHCHECK spell out the node path.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production \
    TZ=UTC
COPY src ./src
COPY package.json ./

# Explicit non-root (the base is already nonroot; be explicit, don't rely on the
# caller's --user for defense-in-depth).
USER 65532:65532

EXPOSE 9101 9102 9103 9104

# The healthcheck hits the payment mock's /healthz; all four start together.
HEALTHCHECK --interval=2s --timeout=2s --retries=15 --start-period=1s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:9101/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["/app/src/main.mjs"]
