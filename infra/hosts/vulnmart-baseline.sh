#!/bin/sh
# Runs the host baseline steps in order and stops at the first failure.
# Result marker: /var/lib/vulnmart/baseline-ok (success) or /var/lib/vulnmart/baseline-failed (names the failing step).
# /run/sshd (privilege separation directory) does not exist before the first ssh service start on Ubuntu 24.04 (socket activation), and `sshd -t` fails without it: create it first (found live on the first AWS apply).
# The AWS Ubuntu 24.04 image has chrony (already pointed at the Amazon Time Sync address) and no systemd-timesyncd; other images may have the opposite: restart whichever exists (found live on the first AWS apply).
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
STEP=sshd-config-test;     install -d -m 0755 /run/sshd && sshd -t
STEP=restart-ssh;          systemctl restart ssh
STEP=firewall;             /usr/local/sbin/vulnmart-firewall.sh "$PRIVATE_CIDR"
STEP=docker;               /usr/local/sbin/vulnmart-install-docker.sh
STEP=egress;               systemctl daemon-reload && systemctl enable --now vulnmart-egress.service
STEP=secrets-dir;          install -d -m 0700 -o root -g root /opt/vulnmart /opt/vulnmart/secrets
STEP=time-sync;            if systemctl cat systemd-timesyncd.service >/dev/null 2>&1; then systemctl restart systemd-timesyncd; elif systemctl cat chrony.service >/dev/null 2>&1; then systemctl restart chrony; else echo "vulnmart-baseline: no time sync service (systemd-timesyncd or chrony) found" >&2; false; fi
STEP=keepalive;            systemctl daemon-reload && if [ "$KEEPALIVE" = yes ]; then systemctl enable --now vulnmart-keepalive.service; else systemctl disable --now vulnmart-keepalive.service; fi
STEP=unattended-upgrades;  systemctl enable --now unattended-upgrades

STEP=marker
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK_DIR/baseline-ok"
# No automatic reboot is configured (unattended-upgrades installs packages only). Say so when a reboot is pending.
if [ -f /var/run/reboot-required ]; then echo "reboot-required" >> "$MARK_DIR/baseline-ok"; fi
