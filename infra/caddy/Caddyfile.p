# Platform edge on vm-p (story LE-3, ADR 0031). Stock Caddy, no plugin (D-49). TLS from the files that lego writes (docs/runbooks/certificates.md).
# Mounts (see infra/caddy/compose.p.yaml): the certificate folder read-only at /certs, the two secret files at /run/secrets, this file and origin-gate.caddy at /etc/caddy.
{
	# The admin endpoint is a unix socket inside the tmpfs /tmp, never a TCP port: it is what `caddy reload` (the renewal hook of H-115) talks to.
	# Reload: docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock
	admin unix//tmp/caddy-admin.sock
	# certificates come from the files, never from Caddy itself
	auto_https off
	# The default logger also carries the error and warning lines of the proxy, which print the request headers (found by the e2e test, 2026-10-11):
	# the secret header is deleted there too, not only in the access log of origin-gate.caddy.
	log {
		output stdout
		format filter {
			wrap json
			request>headers>X-Origin-Secret delete
		}
	}
}

:443 {
	tls /certs/fullchain.pem /certs/privkey.pem
	import /etc/caddy/origin-gate.caddy
}
