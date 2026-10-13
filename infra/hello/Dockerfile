# Hello image for the first CI-to-VM proof (story L-12). It holds no secret, so its GHCR package is public (the VMs pull without a login).
# busybox 1.37.0 (musl); tag plus multi-arch index digest, the same pin as infra/compose/compose.yaml (checked on 2026-10-08).
FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092
# WORKDIR creates /www as 0755 (COPY --chmod on a new directory would make it unreadable); the file itself is read-only.
WORKDIR /www
COPY --chmod=0444 index.html /www/index.html
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=1s --retries=15 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
