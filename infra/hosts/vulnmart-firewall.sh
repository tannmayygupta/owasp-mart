#!/bin/sh
# Host INPUT filter for the VulnMart ports (D-43, handoff H-103). Safe to run again; it never flushes a chain and never touches FORWARD or the Docker chains.
# Order: loopback, ESTABLISHED/RELATED, path-MTU ICMP, DHCP replies, the public ports, the private ports from the VPC range; the default policy is set to DROP
# LAST, so a failure half-way cannot lock the host out. On an image whose INPUT chain ends in a REJECT (Oracle) the allow rules are inserted before it.
# Docker publishes container ports through its own NAT and FORWARD rules, which this chain never sees: it protects the HOST's own ports only.
# The AWS security groups and network ACLs stay the perimeter; this is the second layer on the host.
# The rules are saved with netfilter-persistent ONLY while no Docker chain exists (first boot, before Docker is installed). Saving on a Docker host would
# write Docker's own rules into the saved file; the script then skips the save and says so (the saved file from the first run keeps applying at boot).
# Usage: vulnmart-firewall.sh <private-source-cidr>   (AWS: the VPC range; Oracle: the subnet)
set -eu
PRIVATE_CIDR="${1:?private source cidr required}"
PUBLIC_PORTS="22 80 443"
PRIVATE_PORTS="9443 9444"

# add_rule <rule...>: append (or insert before a final REJECT) unless already present.
add_rule() {
  if iptables -C INPUT "$@" 2>/dev/null; then return 0; fi
  pos="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
  if [ -n "$pos" ]; then iptables -I INPUT "$pos" "$@"; else iptables -A INPUT "$@"; fi
}

add_rule -i lo -j ACCEPT
add_rule -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
add_rule -p icmp --icmp-type destination-unreachable -j ACCEPT
add_rule -p udp --sport 67 --dport 68 -j ACCEPT
for p in $PUBLIC_PORTS; do
  add_rule -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT
done
for p in $PRIVATE_PORTS; do
  add_rule -p tcp -s "$PRIVATE_CIDR" --dport "$p" -m conntrack --ctstate NEW -j ACCEPT
done

# Default policy last. Everything the host needs is accepted above; the cloud network groups remain the first filter.
iptables -P INPUT DROP

if iptables -n -L DOCKER >/dev/null 2>&1; then
  echo "vulnmart-firewall: a Docker chain exists, so the rules were NOT saved (that would persist Docker's own rules)" >&2
else
  netfilter-persistent save
fi