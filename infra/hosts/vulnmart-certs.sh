#!/bin/sh
# Issues and renews the host's Let's Encrypt certificate by DNS-01 with lego and the DuckDNS provider (D-49, ADR 0030). Caddy (L-12) only loads the files.
# Usage: vulnmart-certs.sh issue [--production] [--force] | renew | status [--short]   (runbook docs/runbooks/certificates.md; D-49, ADR 0030)
# issue: staging unless --production. Production needs a staging success marker for the same CERT_NAME and is refused when a production certificate with more than RENEW_DAYS days left exists, unless --force.
# renew: exits 0 first when there is no production certificate or it is not due (before any token check). status: exit 1 when no production certificate.
# Settings: KEY=value lines of /etc/vulnmart/certs.env (never executed; quotes stripped; the environment wins): CERT_NAME, CERT_EMAIL, RENEW_DAYS (30; keep below half the lifetime),
#   TOKEN_FILE (/opt/vulnmart/secrets/duckdns.token, passed to lego as DUCKDNS_TOKEN_FILE only), CERT_DIR (/opt/vulnmart/certs), LEGO_EXTRA_ARGS. Environment only: MARK_DIR, LEGO_BIN, OPENSSL_BIN, VULNMART_CERTS_ENV.
# Markers in MARK_DIR: certs-staging-ok (first line CERT_NAME), certs-staging-failed, certs-ok, certs-failed (production only). A success clears only its own mode's failure marker; status reads production only.
# One run at a time (flock on MARK_DIR/certs.lock, else exit 1 "already running"). Files are replaced by two renames: Caddy must reload only after the run ends (hook of L-12).
# Exit: 0 ok or nothing to do, 1 failed, 2 bad usage or settings (no network call).
set -eu

ENV_FILE="${VULNMART_CERTS_ENV:-/etc/vulnmart/certs.env}"

# Reads KEY=value lines. Sets a key only when it is not already set in the environment. Never executes anything from the file.
load_env() {
  [ -r "$ENV_FILE" ] || return 0
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line=${_line%"$(printf '\r')"}
    _line=${_line#"${_line%%[![:space:]]*}"}
    case "$_line" in ''|'#'*) continue ;; esac
    case "$_line" in *=*) ;; *) continue ;; esac
    _k=${_line%%=*}
    _v=${_line#*=}
    case "$_v" in
      \"?*\") _v=${_v#\"}; _v=${_v%\"} ;;
      \'?*\') _v=${_v#\'}; _v=${_v%\'} ;;
    esac
    case "$_k" in
      CERT_NAME)        [ -n "${CERT_NAME+x}" ] || CERT_NAME=$_v ;;
      CERT_EMAIL)       [ -n "${CERT_EMAIL+x}" ] || CERT_EMAIL=$_v ;;
      RENEW_DAYS)       [ -n "${RENEW_DAYS+x}" ] || RENEW_DAYS=$_v ;;
      TOKEN_FILE)       [ -n "${TOKEN_FILE+x}" ] || TOKEN_FILE=$_v ;;
      CERT_DIR)         [ -n "${CERT_DIR+x}" ] || CERT_DIR=$_v ;;
      LEGO_EXTRA_ARGS)  [ -n "${LEGO_EXTRA_ARGS+x}" ] || LEGO_EXTRA_ARGS=$_v ;;
    esac
  done < "$ENV_FILE"
}
load_env

CERT_DIR="${CERT_DIR:-/opt/vulnmart/certs}"
MARK_DIR="${MARK_DIR:-/var/lib/vulnmart}"
TOKEN_FILE="${TOKEN_FILE:-/opt/vulnmart/secrets/duckdns.token}"
LEGO_BIN="${LEGO_BIN:-/usr/local/bin/lego}"
RENEW_DAYS="${RENEW_DAYS:-30}"
STAGING_URL="https://acme-staging-v02.api.letsencrypt.org/directory"
PRODUCTION_URL="https://acme-v02.api.letsencrypt.org/directory"

say() { echo "vulnmart-certs: $*"; }
die() { _c=$1; shift; echo "vulnmart-certs: $*" >&2; exit "$_c"; }

case "$RENEW_DAYS" in ''|*[!0-9]*) die 2 "RENEW_DAYS must be a whole number, got: $RENEW_DAYS" ;; esac

now() { if [ -n "${VULNMART_NOW:-}" ]; then echo "$VULNMART_NOW"; else date +%s; fi; }

# days_left <crt file> -> whole days until notAfter (negative when expired); empty when unreadable
days_left() {
  _end=$("${OPENSSL_BIN:-openssl}" x509 -noout -enddate -in "$1" 2>/dev/null | sed 's/^notAfter=//') || return 0
  [ -n "$_end" ] || return 0
  _e=$(date -u -d "$_end" +%s 2>/dev/null) || return 0
  echo $(( (_e - $(now)) / 86400 ))
}

check_name() {
  [ -n "${CERT_NAME:-}" ] || die 2 "CERT_NAME is not set (certs.env)"
  case "$CERT_NAME" in
    *[!a-z0-9.*-]*) die 2 "refused name: $CERT_NAME (only a name like x.duckdns.org or *.x.duckdns.org)" ;;
  esac
  _x=${CERT_NAME#\*.}
  _label=${_x%.duckdns.org}
  if [ "$_label" = "$_x" ] || [ -z "$_label" ]; then die 2 "refused name: $CERT_NAME (must end in .duckdns.org)"; fi
  case "$_label" in
    *.*|*\**|-*|*-) die 2 "refused name: $CERT_NAME (one label before .duckdns.org, no further dots)" ;;
  esac
}

check_token() {
  [ -f "$TOKEN_FILE" ] || die 2 "token file not found: $TOKEN_FILE (root-only file, runbook certificates.md)"
  # Refuse a token file readable or writable by group or others (mode must be 0600 or stricter; stat -c on Linux, stat -f on BSD).
  _m=$(stat -c %a "$TOKEN_FILE" 2>/dev/null || stat -f %Lp "$TOKEN_FILE" 2>/dev/null || echo)
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) _m= ;; esac   # Windows shells cannot report real modes (local tests only)
  if [ -n "$_m" ]; then
    case "$_m" in
      *[!0-7]*) ;;
      *) [ $(( 0$_m & 077 )) -eq 0 ] || die 2 "token file $TOKEN_FILE has mode $_m: it must be 0600 or stricter (chmod 600)" ;;
    esac
  fi
  [ -n "${CERT_EMAIL:-}" ] || die 2 "CERT_EMAIL is not set (certs.env)"
}

# One run at a time (issue and renew).
take_lock() {
  mkdir -p "$MARK_DIR"
  if ! command -v flock >/dev/null 2>&1; then
    echo "vulnmart-certs: warning: flock not found, running without a lock" >&2
    return 0
  fi
  exec 9>"$MARK_DIR/certs.lock"
  flock -n 9 || die 1 "already running (lock $MARK_DIR/certs.lock)"
}

# run_lego <mode: staging|production> <lego command: run|renew>
run_lego() {
  _mode=$1; _cmd=$2
  if [ "$_mode" = production ]; then _srv=$PRODUCTION_URL; else _srv=$STAGING_URL; fi
  _path="$CERT_DIR/lego-$_mode"
  mkdir -p "$_path"
  DUCKDNS_TOKEN_FILE="$TOKEN_FILE"
  export DUCKDNS_TOKEN_FILE
  # shellcheck disable=SC2086
  if [ "$_cmd" = run ]; then
    "$LEGO_BIN" --accept-tos --email "$CERT_EMAIL" --server "$_srv" --dns duckdns --domains "$CERT_NAME" --path "$_path" ${LEGO_EXTRA_ARGS:-} run
  else
    "$LEGO_BIN" --accept-tos --email "$CERT_EMAIL" --server "$_srv" --dns duckdns --domains "$CERT_NAME" --path "$_path" ${LEGO_EXTRA_ARGS:-} renew --days "$RENEW_DAYS"
  fi
}

base_name() { printf '%s' "$CERT_NAME" | tr '*' '_'; }

# publish <mode>: copy the lego files to the folder Caddy mounts (production: live/, staging: staging/)
publish() {
  _mode=$1
  _base=$(base_name)
  _src="$CERT_DIR/lego-$_mode/certificates"
  [ -s "$_src/$_base.crt" ] && [ -s "$_src/$_base.key" ] || return 1
  if [ "$_mode" = production ]; then _dst="$CERT_DIR/live"; else _dst="$CERT_DIR/staging"; fi
  mkdir -p "$_dst"
  # One unit: any failing step returns 1 (callers test publish with "if !", where set -e is off), so a failed copy never stamps certs-ok.
  cp "$_src/$_base.crt" "$_dst/fullchain.pem.new" \
    && cp "$_src/$_base.key" "$_dst/privkey.pem.new" \
    && chmod 0644 "$_dst/fullchain.pem.new" \
    && chmod 0600 "$_dst/privkey.pem.new" \
    && mv "$_dst/fullchain.pem.new" "$_dst/fullchain.pem" \
    && mv "$_dst/privkey.pem.new" "$_dst/privkey.pem" \
    || { rm -f "$_dst/fullchain.pem.new" "$_dst/privkey.pem.new"; return 1; }
}

# fail_marker <mode> <what>: production problems go to certs-failed, staging problems to certs-staging-failed
fail_marker() {
  mkdir -p "$MARK_DIR"
  if [ "$1" = production ]; then _f=certs-failed; else _f=certs-staging-failed; fi
  echo "$2 $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARK_DIR/$_f"
}
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK_DIR/$1"; }

do_issue() {
  _mode=staging; _force=no
  for _a in "$@"; do
    case "$_a" in
      --production) _mode=production ;;
      --force) _force=yes ;;
      *) die 2 "unknown option: $_a" ;;
    esac
  done
  check_name; check_token
  take_lock
  mkdir -p "$CERT_DIR" "$MARK_DIR"
  chmod 0700 "$CERT_DIR" 2>/dev/null || true
  if [ "$_mode" = production ]; then
    if [ ! -f "$MARK_DIR/certs-staging-ok" ]; then
      die 1 "production refused: no staging success marker. Run 'vulnmart-certs.sh issue' (staging) first and check it succeeded."
    fi
    _sn=$(head -n 1 "$MARK_DIR/certs-staging-ok")
    if [ "$_sn" != "$CERT_NAME" ]; then
      die 1 "production refused: the staging success was for a different name (${_sn:-unknown}), not $CERT_NAME. Run staging again for this name."
    fi
    if [ "$_force" != yes ] && [ -f "$MARK_DIR/certs-ok" ] && [ -f "$CERT_DIR/live/fullchain.pem" ]; then
      _d=$(days_left "$CERT_DIR/live/fullchain.pem")
      if [ -n "$_d" ] && [ "$_d" -gt "$RENEW_DAYS" ]; then
        die 1 "production refused: a production certificate with $_d days left already exists (a duplicate counts against the Let's Encrypt limits). Use --force only on purpose."
      fi
    fi
  fi
  say "issuing $CERT_NAME against $_mode"
  if ! run_lego "$_mode" run; then
    fail_marker "$_mode" "issue-$_mode"
    die 1 "lego failed ($_mode); see the journal. Marker: $MARK_DIR/$([ "$_mode" = production ] && echo certs-failed || echo certs-staging-failed)"
  fi
  if ! publish "$_mode"; then
    fail_marker "$_mode" "publish-$_mode"
    die 1 "lego reported success but no certificate files were found"
  fi
  if [ "$_mode" = production ]; then
    rm -f "$MARK_DIR/certs-failed"
    stamp certs-ok
  else
    rm -f "$MARK_DIR/certs-staging-failed"
    { echo "$CERT_NAME"; date -u +%Y-%m-%dT%H:%M:%SZ; } > "$MARK_DIR/certs-staging-ok"
  fi
  say "$_mode certificate for $CERT_NAME written"
}

do_renew() {
  take_lock
  _crt="$CERT_DIR/live/fullchain.pem"
  # Nothing to renew, or not due: exit 0 before any settings or token check, so an unconfigured host does not fail the timer.
  if [ ! -f "$MARK_DIR/certs-ok" ] || [ ! -f "$_crt" ]; then
    say "no production certificate yet; nothing to renew"
    exit 0
  fi
  _d=$(days_left "$_crt")
  if [ -n "$_d" ] && [ "$_d" -gt "$RENEW_DAYS" ]; then
    say "certificate valid for $_d more days (renew at $RENEW_DAYS); nothing to do"
    exit 0
  fi
  check_name; check_token
  _lc="$CERT_DIR/lego-production/certificates/$(base_name).crt"
  if [ ! -f "$_lc" ]; then
    fail_marker production renew-no-lego-state
    die 1 "renewal impossible: $_lc not found (lego state of the production issue is missing). Issue again with 'issue --production --force'."
  fi
  say "renewing $CERT_NAME (days left: ${_d:-unknown})"
  if ! run_lego production renew; then
    fail_marker production renew-production
    die 1 "renewal failed; see the journal. Marker: $MARK_DIR/certs-failed"
  fi
  if ! publish production; then
    fail_marker production publish-production
    die 1 "renewal reported success but no certificate files were found"
  fi
  rm -f "$MARK_DIR/certs-failed"
  stamp certs-ok
  say "renewed"
}

do_status() {
  _short=no
  [ "${1:-}" != --short ] || _short=yes
  _crt="$CERT_DIR/live/fullchain.pem"
  _d=
  [ ! -f "$_crt" ] || _d=$(days_left "$_crt")
  if [ -f "$MARK_DIR/certs-failed" ]; then _st=failed; elif [ -f "$MARK_DIR/certs-ok" ] && [ -n "$_d" ]; then _st=ok; else _st=none; fi
  if [ "$_short" = yes ]; then
    echo "$_st:${_d:-na}"
  else
    echo "state=$_st"
    echo "days_left=${_d:-na}"
    echo "staging_marker=$([ -f "$MARK_DIR/certs-staging-ok" ] && echo yes || echo no)"
    echo "production_marker=$([ -f "$MARK_DIR/certs-ok" ] && echo yes || echo no)"
    if [ -f "$MARK_DIR/certs-failed" ]; then echo "failed=$(cat "$MARK_DIR/certs-failed")"; fi
  fi
  [ "$_st" != none ] || exit 1
}

case "${1:-}" in
  issue) shift; do_issue "$@" ;;
  renew) do_renew ;;
  status) shift; do_status "$@" ;;
  *) die 2 "usage: vulnmart-certs.sh issue [--production] [--force] | renew | status [--short]" ;;
esac
