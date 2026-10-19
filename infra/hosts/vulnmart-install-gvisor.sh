#!/bin/sh
# Installs gVisor (runsc) as an EXTRA Docker runtime on a lab host (S-8, story L-29). The daemon's default runtime stays runc: nothing changes for a container that does
# not ask for runsc, and the orchestrator asks for it only when VULNMART_ORCH_RUNTIME=runsc.
# Usage (as root): vulnmart-install-gvisor.sh <latest|release> [<sha512>] [--no-restart]
#   <release>  "latest" or a release name such as 20260915.0 (the pin of infra/hosts/gvisor.pin.json). A pinned install passes the expected sha512 of the tarball:
#              the download is refused when it differs. "latest" has no pin: the script prints the version and the sha512 so they can be pinned.
# The tarball comes from Google's release bucket (https://storage.googleapis.com/gvisor/releases/release/<release>/x86_64/gvisor.tar.zstd, with runsc, the containerd shim
# and gvisor-bin); its published .sha512 is checked too. It is unpacked into /usr/local/bin. daemon.json gets {"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}}
# merged in with the argument --host-uds=all (every other key is kept). Docker is restarted once; live-restore keeps the running containers (the orchestrator, the edge and the instances) running.
# Safe to repeat. Exit 0 ok, 1 failed, 2 bad usage.
set -eu
RELEASE="${1:-}"
EXPECT="${2:-}"
RESTART=1
for a in "$@"; do [ "$a" = --no-restart ] && RESTART=0; done
case "$EXPECT" in --no-restart) EXPECT="" ;; esac
case "$RELEASE" in latest|[0-9]*) ;; *) echo "usage: vulnmart-install-gvisor.sh <latest|release> [sha512] [--no-restart]" >&2; exit 2 ;; esac
case "$RELEASE" in *[!0-9.a-z]*) echo "vulnmart-install-gvisor: the release name has odd characters" >&2; exit 2 ;; esac
case "$EXPECT" in ''|*[!0-9a-f]*) [ -z "$EXPECT" ] || { echo "vulnmart-install-gvisor: the sha512 must be hex" >&2; exit 2; } ;; esac
[ "$(uname -m)" = x86_64 ] || { echo "vulnmart-install-gvisor: this script installs the x86_64 build only" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "vulnmart-install-gvisor: run as root" >&2; exit 2; }
command -v zstd >/dev/null 2>&1 || { apt-get install -y -qq zstd >/dev/null; }
BASE="https://storage.googleapis.com/gvisor/releases/release/$RELEASE/x86_64"
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
curl -fsSL --retry 3 -o "$DIR/gvisor.tar.zstd" "$BASE/gvisor.tar.zstd"
curl -fsSL --retry 3 -o "$DIR/gvisor.tar.zstd.sha512" "$BASE/gvisor.tar.zstd.sha512"
GOT=$(sha512sum "$DIR/gvisor.tar.zstd" | cut -d' ' -f1)
PUB=$(cut -d' ' -f1 "$DIR/gvisor.tar.zstd.sha512")
[ "$GOT" = "$PUB" ] || { echo "vulnmart-install-gvisor: the download does not match the published sha512" >&2; exit 1; }
if [ -n "$EXPECT" ] && [ "$GOT" != "$EXPECT" ]; then echo "vulnmart-install-gvisor: the sha512 differs from the pin" >&2; exit 1; fi
mkdir "$DIR/x"
tar --zstd -xf "$DIR/gvisor.tar.zstd" -C "$DIR/x"
[ -x "$DIR/x/runsc" ] || { echo "vulnmart-install-gvisor: the tarball has no runsc" >&2; exit 1; }
# Each file is written under a temporary name and renamed over the old one: a running sandbox keeps its open copy, so an upgrade works while instances run
# (a plain copy over a running program fails with "Text file busy"). Found live on vm-i.
(cd "$DIR/x" && find . -type f) | while read -r f; do
  dest="/usr/local/bin/${f#./}"
  mkdir -p "$(dirname "$dest")"
  install -m 755 -o root -g root "$DIR/x/$f" "$dest.new"
  mv -f "$dest.new" "$dest"
done
VERSION=$(/usr/local/bin/runsc --version | head -1)
echo "vulnmart-install-gvisor: installed $VERSION tarball-sha512=$GOT"
python3 - <<'PY'
import json, os
p = "/etc/docker/daemon.json"
d = json.load(open(p)) if os.path.exists(p) else {}
# --host-uds=all: two sandboxes that share a volume can connect through a unix socket in it (the import service and the shop share /run/import). Without it a socket made in one
# sandbox does not exist in the other (ENOENT, found live). It lets a sandbox create and connect unix sockets only inside the paths it has mounted: an instance mounts its own volumes.
d.setdefault("runtimes", {})["runsc"] = {"path": "/usr/local/bin/runsc", "runtimeArgs": ["--host-uds=all"]}
tmp = p + ".new"
open(tmp, "w").write(json.dumps(d, indent=2) + "\n")
os.replace(tmp, p)
PY
if [ "$RESTART" = 1 ]; then
  systemctl restart docker
  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
docker info --format '{{json .Runtimes}}' | grep -c '"runsc"' | sed 's/^/runsc runtime entries: /'