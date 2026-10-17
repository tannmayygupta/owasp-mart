# VulnMart support-agent bot controller — hardened container image (T-13, FR-SHP-11).
#
# Node built-ins only (no dependency install stage). Listens on 9200 on the
# instance network. Hardening follows the instance contract section 7: non-root
# uid 65532, read-only root filesystem, no added capabilities, writable only on
# tmpfs. The headless-browser visitor (for C03 page JS) and its memory profile
# are the spike S-5 / C03 work; this image is the controller.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production \
    PORT=9200 \
    TZ=UTC
COPY src ./src
COPY package.json ./

# Explicit non-root for defense-in-depth (don't rely on the caller's --user).
USER 65532:65532

EXPOSE 9200

HEALTHCHECK --interval=2s --timeout=2s --retries=15 --start-period=1s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||9200)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["/app/src/main.mjs"]
