#!/bin/sh
# Opens the host firewall for the VulnMart ports and saves the rules. Safe to run again.
# Usage: vulnmart-firewall.sh <private-subnet-cidr>
# Oracle Ubuntu images ship an iptables INPUT chain that ends in a REJECT; allow rules must sit before it.
# The cloud network groups are the real filter; this is the second layer on the host.
set -eu
PRIVATE_CIDR="${1:?private subnet cidr required}"
PUBLIC_PORTS="22 80 443"
PRIVATE_PORTS="9443 9444"

insert_before_reject() {
  # $@ = the rule, without -I/-A
  if iptables -C INPUT "$@" 2>/dev/null; then return 0; fi
  pos="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
  if [ -n "$pos" ]; then iptables -I INPUT "$pos" "$@"; else iptables -A INPUT "$@"; fi
}

for p in $PUBLIC_PORTS; do
  insert_before_reject -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT
done
for p in $PRIVATE_PORTS; do
  insert_before_reject -p tcp -s "$PRIVATE_CIDR" --dport "$p" -m conntrack --ctstate NEW -j ACCEPT
done
netfilter-persistent save
