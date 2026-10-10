#!/bin/sh
# Runs the host baseline steps in order and stops at the first failure.
# Result marker: /var/lib/vulnmart/baseline-ok (success) or /var/lib/vulnmart/baseline-failed (names the failing step).
# Usage: vulnmart-baseline.sh <private-subnet-cidr> [keepalive: yes|no, default no]
set -eu
PRIVATE_CIDR="${1:?private subnet cidr required}"
KEEPALIVE="${2:-no}"
case "$KEEPALIVE" in
  yes|no) ;;
  *) echo "vulnmart-baseline: keep-alive argument must be yes or no, got: $KEEPALIVE" >&2; exit 2 ;;
esac
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
STEP=keepalive;            systemctl daemon-reload && if [ "$KEEPALIVE" = yes ]; then systemctl enable --now vulnmart-keepalive.service; else systemctl disable --now vulnmart-keepalive.service; fi
STEP=unattended-upgrades;  systemctl enable --now unattended-upgrades

STEP=marker
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK_DIR/baseline-ok"
# No automatic reboot is configured (unattended-upgrades installs packages only). Say so when a reboot is pending.
if [ -f /var/run/reboot-required ]; then echo "reboot-required" >> "$MARK_DIR/baseline-ok"; fi
