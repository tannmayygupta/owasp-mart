#!/bin/sh
# Installs Docker Engine from Docker's official apt repository after checking the signing key fingerprint.
# The fingerprint was read from the key itself on 2026-10-10 and matches the value Docker has published;
# Docker's current install page does not state it, so re-check it when the key rotates.
set -eu
EXPECTED_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

install -m 0755 -d /etc/apt/keyrings
curl -fsSL --retry 5 --connect-timeout 10 --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.asc
fprs="$(gpg --show-keys --with-colons /tmp/docker.asc | awk -F: '$1 == "fpr" {print $10}')"
case "$fprs" in
  *"$EXPECTED_FPR"*) ;;
  *) echo "Docker key fingerprint mismatch: refusing to install" >&2; rm -f /tmp/docker.asc; exit 1 ;;
esac
install -m 0644 /tmp/docker.asc /etc/apt/keyrings/docker.asc
rm -f /tmp/docker.asc

. /etc/os-release
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get -o DPkg::Lock::Timeout=300 update
DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
