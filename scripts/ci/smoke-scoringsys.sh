#!/usr/bin/env bash
set -Eeuo pipefail

# Public delivery contract for scoringsys, verified against the running workload:
#   GET ${PUBLIC_PREFIX}   -> 200 text/html, carries the business marker and
#                             references ${PUBLIC_PREFIX}/_next/static/... assets
#   GET ${PUBLIC_PREFIX}/  -> 30x with Location ${PUBLIC_PREFIX}
# Next.js runs with basePath=${PUBLIC_PREFIX} and trailingSlash=false, so the
# canonical URL is the one WITHOUT the trailing slash and the slashed form is
# what redirects. Asserting the opposite direction can never pass.

PUBLIC_HOST=${PUBLIC_HOST:-nexus.youdoogo.com}
PUBLIC_PREFIX=${PUBLIC_PREFIX:-/scoringsys}
SMOKE_HTML_MARKER=${SMOKE_HTML_MARKER:-立项评审在线打分系统}
SMOKE_ATTEMPTS=${SMOKE_ATTEMPTS:-10}
SMOKE_DELAY_SECONDS=${SMOKE_DELAY_SECONDS:-3}
REQUEST_TIMEOUT_SECONDS=${REQUEST_TIMEOUT_SECONDS:-10}
DB_HEALTH_PATH=${DB_HEALTH_PATH:-${PUBLIC_PREFIX}/api/health/db}
SUMMARY_PATH=${SUMMARY_PATH:-${PUBLIC_PREFIX}/api/summary}
SMOKE_SUMMARY_MEETING_ID=${SMOKE_SUMMARY_MEETING_ID:-}
SMOKE_AUTH_COOKIE=${SMOKE_AUTH_COOKIE:-}

if [[ -n "$SMOKE_SUMMARY_MEETING_ID" && "$SUMMARY_PATH" != *\?* ]]; then
  SUMMARY_PATH="${SUMMARY_PATH}?meetingId=${SMOKE_SUMMARY_MEETING_ID}"
fi

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
slashed_url="${canonical_url}/"
# PUBLIC_PREFIX is already restricted to [A-Za-z0-9._/-]; only "." is a regex
# metacharacter in that set, so escaping it is enough to build a literal match.
prefix_pattern=${PUBLIC_PREFIX//./\\.}

# TLS verification is deliberately left at curl's strict default. Never add
# --insecure/-k here: the public contract includes a valid certificate chain.
request_status() {
  local url=$1 headers_file=$2 body_file=$3 status
  # curl still writes %{http_code} (as 000) when the transfer itself fails, so
  # the exit-code fallback must REPLACE that output rather than append to it --
  # concatenating produced "000000", which no transient-status branch matches
  # and which therefore turned a retryable network blip into a hard failure.
  if [[ -n "$SMOKE_AUTH_COOKIE" ]]; then
    status=$(curl --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
      --header "Cookie: $SMOKE_AUTH_COOKIE" \
      --dump-header "$headers_file" --output "$body_file" \
      --write-out '%{http_code}' "$url" 2>/dev/null) || status=""
  else
    status=$(curl --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
      --dump-header "$headers_file" --output "$body_file" \
      --write-out '%{http_code}' "$url" 2>/dev/null) || status=""
  fi
  case "$status" in
    [0-9][0-9][0-9]) printf '%s' "$status" ;;
    *) printf '000' ;;
  esac
}

# 404 stays retryable: while the CCE controller is still publishing the ELB
# forwarding policy, requests fall through to the shared listener's "/" catch-all
# and come back as the master backend's 404.
is_transient_status() {
  case "$1" in
    000|404|502|503) return 0 ;;
    *) return 1 ;;
  esac
}

read_header() {
  awk -v name="$2" 'BEGIN { IGNORECASE = 1 } $0 ~ "^" name ":" { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }' "$1" | tr -d '\r'
}

# Compare a Location against the canonical path whether the server answered with
# a relative path or an absolute URL.
location_path() {
  printf '%s' "$1" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*##'
}

check_trailing_slash_redirect() {
  local headers_file body_file status location
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status=$(request_status "$slashed_url" "$headers_file" "$body_file")
  location=$(read_header "$headers_file" location)
  rm -f "$headers_file" "$body_file"
  case "$status" in
    301|302|307|308)
      [[ "$(location_path "$location")" == "$PUBLIC_PREFIX" ]] || {
        printf '%s/ redirected to %s instead of %s\n' "$PUBLIC_PREFIX" "$location" "$PUBLIC_PREFIX" >&2
        return 1
      }
      return 0
      ;;
    *)
      if is_transient_status "$status"; then return 10; fi
      printf '%s/ returned HTTP %s instead of a redirect to %s\n' "$PUBLIC_PREFIX" "$status" "$PUBLIC_PREFIX" >&2
      return 1
      ;;
  esac
}

check_page_and_asset() {
  local headers_file body_file status content_type asset_path asset_headers asset_status
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status=$(request_status "$canonical_url" "$headers_file" "$body_file")
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
  asset_path=$(grep -oE "${prefix_pattern}/_next/static/[^\"[:space:]<>]+" "$body_file" | head -n 1 || true)
  [[ -n "$asset_path" ]] || {
    rm -f "$headers_file" "$body_file"
    printf 'page did not expose a Next.js static asset\n' >&2
    return 1
  }
  asset_headers=$(mktemp)
  asset_status=$(request_status "${base_url}${asset_path}" "$asset_headers" /dev/null)
  content_type=$(read_header "$asset_headers" content-type | tr '[:upper:]' '[:lower:]')
  rm -f "$headers_file" "$body_file" "$asset_headers"
  if [[ "$asset_status" != "200" ]]; then
    if is_transient_status "$asset_status"; then return 10; fi
    printf 'static asset returned HTTP %s\n' "$asset_status" >&2
    return 1
  fi
  # An HTML content-type here means the asset request was swallowed by an
  # application/catch-all route rather than served from the Next.js build.
  [[ "$content_type" != text/html* ]] || { printf 'static asset unexpectedly returned HTML\n' >&2; return 1; }
}

check_db_health() {
  local headers_file body_file status content_type
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status=$(request_status "${base_url}${DB_HEALTH_PATH}" "$headers_file" "$body_file")
  content_type=$(read_header "$headers_file" content-type | tr '[:upper:]' '[:lower:]')
  if [[ "$status" != "200" ]]; then
    rm -f "$headers_file" "$body_file"
    if is_transient_status "$status"; then return 10; fi
    printf 'database health returned HTTP %s\n' "$status" >&2
    return 1
  fi
  grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$body_file" || {
    rm -f "$headers_file" "$body_file"
    printf 'database health did not report ok=true\n' >&2
    return 1
  }
  [[ "$content_type" == application/json* || -z "$content_type" ]] || {
    rm -f "$headers_file" "$body_file"
    printf 'database health returned an unexpected content type\n' >&2
    return 1
  }
  rm -f "$headers_file" "$body_file"
}

check_summary_json() {
  local headers_file body_file status content_type
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status=$(request_status "${base_url}${SUMMARY_PATH}" "$headers_file" "$body_file")
  content_type=$(read_header "$headers_file" content-type | tr '[:upper:]' '[:lower:]')
  if [[ "$status" != "200" ]]; then
    rm -f "$headers_file" "$body_file"
    if is_transient_status "$status"; then return 10; fi
    printf 'summary returned HTTP %s\n' "$status" >&2
    return 1
  fi
  grep -Eq '^[[:space:]]*[\[{]' "$body_file" || {
    rm -f "$headers_file" "$body_file"
    printf 'summary did not return a JSON object or array\n' >&2
    return 1
  }
  [[ "$content_type" == application/json* || -z "$content_type" ]] || {
    rm -f "$headers_file" "$body_file"
    printf 'summary returned an unexpected content type\n' >&2
    return 1
  }
  rm -f "$headers_file" "$body_file"
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

run_bounded_check page-and-static-asset check_page_and_asset || die "${PUBLIC_PREFIX} did not serve the page/static asset contract"
run_bounded_check trailing-slash-redirect check_trailing_slash_redirect || die "${PUBLIC_PREFIX}/ did not redirect to ${PUBLIC_PREFIX}"
run_bounded_check database-health check_db_health || die "${DB_HEALTH_PATH} did not report database health"
if [[ -n "$SMOKE_SUMMARY_MEETING_ID" ]]; then
  run_bounded_check summary-json check_summary_json || die "${SUMMARY_PATH} did not return JSON"
else
  printf 'summary-json skipped: SMOKE_SUMMARY_MEETING_ID is not configured\n'
fi
