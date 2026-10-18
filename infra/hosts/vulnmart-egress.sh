#!/bin/sh
# Host rules that hold lab containers back (D-43, review finding H-103). Runs on the labs host only; on any other host it exits 0 and changes nothing.
# Settings come from /etc/vulnmart/egress.env (written by cloud-init) or the environment:
#   VPC_CIDR, VPC_RESOLVER, PLATFORM_SUBNET, LABS_HOST_SUBNET, LABS_DOCKER_SUBNETS (space separated), INGEST_PORT; HOST_PRIVATE_IP (optional, for tests).
# What it does, in this order, and never flushes a Docker chain (it owns only the chain VULNMART-LABS):
#   1. OUTPUT: drop 169.254.169.254 (instance metadata) for every process that is not root.
#   2. DOCKER-USER: traffic from the lab bridge subnets goes to VULNMART-LABS: replies RETURN; the allowlist is ACCEPTed; metadata/link-local, the VPC range and this
#      host's own private address are DROPped; then https is ACCEPTed; everything else is DROPped (port 80 is not allowed to containers).
#   3. INPUT: a NEW connection from a lab subnet to this host is dropped (a container may not reach the host's own ports through its private address).
# Idempotent: the jump and INPUT/OUTPUT rules are checked with -C before they are inserted; the own chain is rebuilt. Run again at every boot and when Docker restarts (vulnmart-egress.service).
# LIMIT (say it plainly): a root or privileged container, or a container with host networking, can change or bypass host filters. The VPC security groups and network ACLs are the real boundary; compose files that ask for those rights fail scripts/check-lab-compose-rules.mjs.
set -eu

ENV_FILE="${VULNMART_EGRESS_ENV:-/etc/vulnmart/egress.env}"
if [ -z "${LABS_HOST_SUBNET:-}" ] && [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
if [ -z "${LABS_HOST_SUBNET:-}" ]; then
  echo "vulnmart-egress: no LABS_HOST_SUBNET configured; nothing to do"
  exit 0
fi
: "${VPC_CIDR:?VPC_CIDR required}" "${VPC_RESOLVER:?VPC_RESOLVER required}" "${PLATFORM_SUBNET:?PLATFORM_SUBNET required}"
: "${LABS_DOCKER_SUBNETS:?LABS_DOCKER_SUBNETS required}" "${INGEST_PORT:?INGEST_PORT required}"

ip_to_int() {
  _o1=${1%%.*}; _r=${1#*.}; _o2=${_r%%.*}; _r=${_r#*.}; _o3=${_r%%.*}; _o4=${_r#*.}
  echo $(( (_o1 << 24) + (_o2 << 16) + (_o3 << 8) + _o4 ))
}
in_cidr() { # in_cidr <ip> <cidr>
  _net=${2%/*}; _bits=${2#*/}
  _mask=$(( (0xFFFFFFFF << (32 - _bits)) & 0xFFFFFFFF ))
  [ $(( $(ip_to_int "$1") & _mask )) -eq $(( $(ip_to_int "$_net") & _mask )) ]
}

HOST_IP="${HOST_PRIVATE_IP:-$(ip -4 route get 192.0.2.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')}"

# 1. Metadata is for root only (cloud-init and the agent run as root). The hop limit already stops containers; this also stops non-root host users.
if ! iptables -C OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j DROP 2>/dev/null; then
  iptables -I OUTPUT 1 -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j DROP
fi

if [ -z "$HOST_IP" ] || ! in_cidr "$HOST_IP" "$LABS_HOST_SUBNET"; then
  echo "vulnmart-egress: this host (${HOST_IP:-unknown address}) is not in the labs subnet; only the metadata rule was applied"
  exit 0
fi

iptables -n -L DOCKER-USER >/dev/null 2>&1 || { echo "vulnmart-egress: the DOCKER-USER chain does not exist: start Docker first" >&2; exit 1; }

# 2. Own chain, rebuilt each time (never touch Docker's chains).
CH=VULNMART-LABS
iptables -N "$CH" 2>/dev/null || true
iptables -F "$CH"
iptables -A "$CH" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A "$CH" -p udp -d "$VPC_RESOLVER/32" --dport 53 -j ACCEPT
iptables -A "$CH" -p tcp -d "$VPC_RESOLVER/32" --dport 53 -j ACCEPT
iptables -A "$CH" -p udp -d 169.254.169.123/32 --dport 123 -j ACCEPT
iptables -A "$CH" -p tcp -d "$PLATFORM_SUBNET" --dport "$INGEST_PORT" -j ACCEPT
iptables -A "$CH" -d 169.254.0.0/16 -j DROP
iptables -A "$CH" -d "$VPC_CIDR" -j DROP
iptables -A "$CH" -d "$HOST_IP/32" -j DROP
# No traffic between container networks through the host, and no tcp/443 for containers (an ACCEPT here skips Docker's isolation; audit B4).
for s in $LABS_DOCKER_SUBNETS; do
  iptables -A "$CH" -d "$s" -j DROP
done
iptables -A "$CH" -j DROP

for s in $LABS_DOCKER_SUBNETS; do
  if ! iptables -C DOCKER-USER -s "$s" -j "$CH" 2>/dev/null; then
    iptables -I DOCKER-USER 1 -s "$s" -j "$CH"
  fi
  # 3. Lab subnet to this host.
  if ! iptables -C INPUT -s "$s" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
    iptables -I INPUT 1 -s "$s" -m conntrack --ctstate NEW -j DROP
  fi
done
echo "vulnmart-egress: rules applied for $LABS_DOCKER_SUBNETS"