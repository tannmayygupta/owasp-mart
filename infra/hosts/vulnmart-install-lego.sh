#!/bin/sh
# Installs the pinned lego release (D-49, ADR 0030): download, verify the sha256 from lego.pin.json, extract, install. No pip, no snap.
# Refuses (exit 1) on a checksum mismatch and installs nothing. Skips when the pinned version is already installed.
# The pin file has one key per line (parsed with sed, no JSON tool needed). Overrides for tests: LEGO_PIN, LEGO_DEST, LEGO_ARCH, CURL_BIN.
# Usage: vulnmart-install-lego.sh
set -eu
PIN="${LEGO_PIN:-/etc/vulnmart/lego.pin.json}"
DEST="${LEGO_DEST:-/usr/local/bin/lego}"
[ -r "$PIN" ] || { echo "vulnmart-install-lego: pin file not found: $PIN" >&2; exit 2; }
ARCH="${LEGO_ARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64) K=amd64 ;;
  aarch64|arm64) K=arm64 ;;
  *) echo "vulnmart-install-lego: unsupported architecture: $ARCH" >&2; exit 2 ;;
esac
get() { sed -n "s/^ *\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$PIN" | head -n 1; }
VERSION=$(get version); PREFIX=$(get url_prefix); FILE=$(get "${K}_file"); SUM=$(get "${K}_sha256")
if [ -z "$VERSION" ] || [ -z "$PREFIX" ] || [ -z "$FILE" ] || [ -z "$SUM" ]; then
  echo "vulnmart-install-lego: the pin file is incomplete for $K" >&2; exit 2
fi
if [ -x "$DEST" ] && "$DEST" --version 2>/dev/null | grep -qF "${VERSION#v}"; then
  echo "vulnmart-install-lego: lego $VERSION already installed"; exit 0
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
"${CURL_BIN:-curl}" -fsSL --connect-timeout 15 --max-time 180 --retry 3 -o "$TMP/$FILE" "$PREFIX$FILE"
GOT=$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)
if [ "$GOT" != "$SUM" ]; then
  echo "vulnmart-install-lego: checksum mismatch for $FILE (expected $SUM, got $GOT); nothing installed" >&2
  exit 1
fi
tar -xzf "$TMP/$FILE" -C "$TMP" lego
install -m 0755 "$TMP/lego" "$DEST"
echo "vulnmart-install-lego: installed lego $VERSION"
