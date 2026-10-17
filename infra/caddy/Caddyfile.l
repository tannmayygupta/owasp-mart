# Labs edge on vm-i (story edge-2, D-62). Stock Caddy, no plugin. TLS from the files that lego writes for the wildcard certificate of the labs zone.
# Caddy only does TLS and the strict host test; the decision for each request (ticket, cookie, access state, upstream) is the gate service's (apps/edge).
# Environment (see infra/compose/compose.yaml, service edge-caddy): EDGE_ZONE (the labs zone), EDGE_GATE_UPSTREAM (default edge-gate:8080).
# Mounts: the certificate folder read-only at /certs (fullchain.pem, privkey.pem), this file at /etc/caddy/Caddyfile.
# Adds NO security header to any answer (D-62): CSP, HSTS and the like are not set here because the shops are deliberately vulnerable.
{
	# The admin endpoint is a unix socket inside the tmpfs /tmp, never a TCP port (the same as Caddyfile.p).
	admin unix//tmp/caddy-admin.sock
	# certificates come from the files, never from Caddy itself; port 80 is not used
	auto_https off
	# Stock Caddy has no read timeouts: without these a slow client holds a connection on the public port (review of 2026-10-17, finding 2).
	servers {
		timeouts {
			read_header 10s
			read_body 60s
			idle 2m
		}
	}
	# The ticket is in the query string (single use, 60 s) and the gate cookie is a credential: neither goes into a log line.
	log {
		output stdout
		format filter {
			wrap json
			request>headers>Cookie delete
			request>headers>Authorization delete
			resp_headers>Set-Cookie delete
			request>uri query {
				replace t REDACTED
			}
		}
	}
}

:443 {
	tls /certs/fullchain.pem /certs/privkey.pem
	log {
		output stdout
		format filter {
			wrap json
			request>headers>Cookie delete
			request>headers>Authorization delete
			resp_headers>Set-Cookie delete
			request>uri query {
				replace t REDACTED
			}
		}
	}

	# Exactly one label of the form i-<16 base32 characters> in front of the zone. Upper case, a second label, another zone, an IP address or
	# a bare name never match; the gate checks the same rule again (contracts/edge/gate-ticket.md section 4).
	@instance {
		host *.{$EDGE_ZONE}
		header_regexp inst Host ^i-[a-z2-7]{16}\.{$EDGE_ZONE}$
	}

	handle @instance {
		reverse_proxy {$EDGE_GATE_UPSTREAM:edge-gate:8080} {
			flush_interval -1
		}
	}

	# Everything else: a fixed 404, the gate is not asked.
	handle {
		respond 404
	}
}
