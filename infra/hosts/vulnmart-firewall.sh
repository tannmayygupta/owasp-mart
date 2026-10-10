#!/bin/sh
# Adds ACCEPT rules for the VulnMart ports to the host INPUT chain and saves them. Safe to run again.
# On the AWS Ubuntu image the INPUT policy is ACCEPT and these are only ACCEPT rules, so this script filters NOTHING
# today: the AWS security groups are the only perimeter. The rules are a placeholder for a later default-drop policy
# (handoff H-103, tasks L-15 and L-29). On an Oracle image the chain ends in a REJECT, so there they matter.
# Usage: vulnmart-firewall.sh <private-subnet-cidr>
# Some cloud Ubuntu images (Oracle) ship an iptables INPUT chain that ends in a REJECT; allow rules must sit before it.
# Others (AWS) have an empty INPUT chain with policy ACCEPT: the rules are then added at the end and the cloud security groups do the filtering.
# The cloud network groups are the real filter.
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
