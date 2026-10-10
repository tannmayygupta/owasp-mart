#!/bin/sh
# Runs the host baseline steps in order and stops at the first failure.
# Result marker: /var/lib/vulnmart/baseline-ok (success) or /var/lib/vulnmart/baseline-failed (names the failing step).
# Usage: vulnmart-baseline.sh <private-subnet-cidr>
set -eu
PRIVATE_CIDR="${1:?private subnet cidr required}"
MARK_DIR=/var/lib/vulnmart
mkdir -p "$MARK_DIR"
rm -f "$MARK_DIR/baseline-ok" "$MARK_DIR/baseline-failed"
STEP=start
trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo "step=$STEP exit=$rc" > "$MARK_DIR/baseline-failed"; fi' EXIT

STEP=lock-root;            passwd -l root
STEP=sshd-config-test;     sshd -t
STEP=restart-ssh;          systemctl restart ssh
STEP=firewall;             /usr/local/sbin/vulnmart-firewall.sh "$PRIVATE_CIDR"
STEP=docker;               /usr/local/sbin/vulnmart-install-docker.sh
STEP=secrets-dir;          install -d -m 0700 -o root -g root /opt/vulnmart /opt/vulnmart/secrets
STEP=time-sync;            systemctl restart systemd-timesyncd
STEP=keepalive;            systemctl daemon-reload && systemctl enable --now vulnmart-keepalive.service
STEP=unattended-upgrades;  systemctl enable --now unattended-upgrades

STEP=marker
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK_DIR/baseline-ok"
