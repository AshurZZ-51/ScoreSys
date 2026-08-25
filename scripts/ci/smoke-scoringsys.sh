#!/usr/bin/env bash
set -Eeuo pipefail

PUBLIC_HOST=${PUBLIC_HOST:-nexus.youdoogo.com}
PUBLIC_PREFIX=${PUBLIC_PREFIX:-/scoringsys}
SMOKE_HTML_MARKER=${SMOKE_HTML_MARKER:-立项评审在线打分系统}
SMOKE_ATTEMPTS=${SMOKE_ATTEMPTS:-10}
SMOKE_DELAY_SECONDS=${SMOKE_DELAY_SECONDS:-3}
REQUEST_TIMEOUT_SECONDS=${REQUEST_TIMEOUT_SECONDS:-10}

die() {
  printf 'scoringsys smoke failed: %s\n' "$1" >&2
  exit 1
}

[[ "$PUBLIC_PREFIX" =~ ^/[A-Za-z0-9._/-]+$ && "$PUBLIC_PREFIX" != "/" && "$PUBLIC_PREFIX" != */*/* ]] || die "PUBLIC_PREFIX must be a single path prefix"
[[ "$SMOKE_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "SMOKE_ATTEMPTS must be a positive integer"
[[ "$SMOKE_DELAY_SECONDS" =~ ^[0-9]+$ ]] || die "SMOKE_DELAY_SECONDS must be a non-negative integer"
command -v curl >/dev/null 2>&1 || die "curl is required"

base_url="https://${PUBLIC_HOST}"
canonical_url="${base_url}${PUBLIC_PREFIX}"
page_url="${canonical_url}/"

request_status() {
  local url=$1
  local headers_file=$2
  local body_file=$3
  curl --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
    --dump-header "$headers_file" --output "$body_file" --write-out '%{http_code}' "$url" 2>/dev/null || printf '000'
}

is_transient_status() {
  case "$1" in
    000|404|502) return 0 ;;
    *) return 1 ;;
  esac
}

check_canonical_redirect() {
  local headers_file body_file status location
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status=$(request_status "$canonical_url" "$headers_file" "$body_file")
  location=$(awk 'BEGIN { IGNORECASE=1 } /^location:/ { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }' "$headers_file" | tr -d '\r')
  rm -f "$headers_file" "$body_file"
  case "$status" in
    301|302|307|308)
      [[ "$location" == "$page_url" || "$location" == "${PUBLIC_PREFIX}/" || "$location" == "${base_url}${PUBLIC_PREFIX}/" ]] || return 1
      return 0
      ;;
    000|404|502)
      return 10
      ;;
    *)
      printf 'canonical URL returned HTTP %s\n' "$status" >&2
      return 1
      ;;
  esac
}

check_page_and_asset() {
  local headers_file body_file status content_type asset_path asset_headers asset_status
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status=$(request_status "$page_url" "$headers_file" "$body_file")
  if [[ "$status" != "200" ]]; then
    rm -f "$headers_file" "$body_file"
    if is_transient_status "$status"; then return 10; fi
    printf 'page returned HTTP %s\n' "$status" >&2
    return 1
  fi
  grep -Fq "$SMOKE_HTML_MARKER" "$body_file" || {
    rm -f "$headers_file" "$body_file"
    printf 'page did not contain the expected HTML marker\n' >&2
    return 1
  }
  asset_path=$(grep -oE '/scoringsys/_next/static/[^"[:space:]<>]+' "$body_file" | head -n 1 || true)
  [[ -n "$asset_path" ]] || {
    rm -f "$headers_file" "$body_file"
    printf 'page did not expose a Next.js static asset\n' >&2
    return 1
  }
  asset_headers=$(mktemp)
  asset_status=$(request_status "${base_url}${asset_path}" "$asset_headers" /dev/null)
  content_type=$(awk 'BEGIN { IGNORECASE=1 } /^content-type:/ { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }' "$asset_headers" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
  rm -f "$headers_file" "$body_file" "$asset_headers"
  if [[ "$asset_status" != "200" ]]; then
    if is_transient_status "$asset_status"; then return 10; fi
    printf 'static asset returned HTTP %s\n' "$asset_status" >&2
    return 1
  fi
  [[ "$content_type" != text/html* ]] || { printf 'static asset unexpectedly returned HTML\n' >&2; return 1; }
}

run_bounded_check() {
  local check_name=$1
  shift
  local attempt result
  for ((attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++)); do
    set +e
    "$@"
    result=$?
    set -e
    if [[ "$result" -eq 0 ]]; then
      printf '%s passed on attempt %d\n' "$check_name" "$attempt"
      return 0
    fi
    if [[ "$result" -ne 10 || "$attempt" -eq "$SMOKE_ATTEMPTS" ]]; then
      return 1
    fi
    sleep "$SMOKE_DELAY_SECONDS"
  done
}

run_bounded_check canonical-redirect check_canonical_redirect || die "${PUBLIC_PREFIX} did not redirect canonically"
run_bounded_check page-and-static-asset check_page_and_asset || die "page/static asset contract did not pass"
