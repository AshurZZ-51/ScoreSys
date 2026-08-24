#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=${CI_PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/../.." && pwd)}
RENDERED_DIR=${RENDERED_DIR:-"$PROJECT_DIR/.rendered/cce"}
NAMESPACE=${KUBE_NAMESPACE:-nexus-prod}
PUBLIC_HOST=${PUBLIC_HOST:-nexus.youdoogo.com}
PUBLIC_PREFIX=${PUBLIC_PREFIX:-/scoringsys}

die() {
  printf 'CCE deploy failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

require_command kubectl
require_command base64
require_command curl

[[ -n "${KUBECONFIG_CCE_B64:-}" ]] || die "KUBECONFIG_CCE_B64 is required"
[[ -n "${KUBE_IMAGE_PULL_SECRET:-}" ]] || die "KUBE_IMAGE_PULL_SECRET is required"
[[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || die "KUBE_NAMESPACE is not DNS-compatible"

workload="$RENDERED_DIR/deployment.yaml"
ingress="$RENDERED_DIR/ingress.yaml"
if [[ ! -s "$workload" || ! -s "$ingress" ]]; then
  require_command python3
  IMAGE_REFERENCE=${IMAGE_REFERENCE:-} python3 "$SCRIPT_DIR/render_cce.py" --output-dir "$RENDERED_DIR" || die "manifest rendering failed"
fi
[[ -s "$workload" && -s "$ingress" ]] || die "rendered manifests are missing"

kubeconfig=$(mktemp)
trap 'rm -f "$kubeconfig"' EXIT
printf '%s' "$KUBECONFIG_CCE_B64" | base64 --decode >"$kubeconfig" || die "invalid KUBECONFIG_CCE_B64"
chmod 600 "$kubeconfig"
export KUBECONFIG="$kubeconfig"

kubectl version --client >/dev/null 2>&1 || die "kubectl client is unavailable"
kubectl get namespace "$NAMESPACE" >/dev/null || die "namespace $NAMESPACE does not exist"

pull_secret_type=$(kubectl -n "$NAMESPACE" get secret "$KUBE_IMAGE_PULL_SECRET" -o jsonpath='{.type}' 2>/dev/null || true)
[[ "$pull_secret_type" == "kubernetes.io/dockerconfigjson" ]] || die "image pull secret has the wrong type"

if [[ -n "${RUNTIME_SECRET_NAME:-}" ]]; then
  kubectl -n "$NAMESPACE" get secret "$RUNTIME_SECRET_NAME" >/dev/null || die "runtime Secret is missing"
fi
if [[ -n "${RUNTIME_CONFIGMAP_NAME:-}" ]]; then
  kubectl -n "$NAMESPACE" get configmap "$RUNTIME_CONFIGMAP_NAME" >/dev/null || die "runtime ConfigMap is missing"
fi

kubectl -n "$NAMESPACE" apply --dry-run=server -f "$workload" >/dev/null || die "workload server dry-run failed"
kubectl -n "$NAMESPACE" apply --dry-run=server -f "$ingress" >/dev/null || die "Ingress server dry-run failed"
kubectl -n "$NAMESPACE" apply -f "$workload" >/dev/null || die "workload apply failed"
kubectl -n "$NAMESPACE" rollout status deployment/scoringsys --timeout=180s >/dev/null || die "deployment rollout failed"

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  addresses=$(kubectl -n "$NAMESPACE" get endpoints scoringsys -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null || true)
  if [[ -n "$addresses" ]]; then
    break
  fi
  sleep 3
done
[[ -n "${addresses:-}" ]] || die "Service has no ready endpoints"

kubectl -n "$NAMESPACE" apply -f "$ingress" >/dev/null || die "Ingress apply failed"

host=$(kubectl -n "$NAMESPACE" get ingress scoringsys -o jsonpath='{.spec.rules[0].host}')
[[ "$host" == "$PUBLIC_HOST" ]] || die "Ingress host does not match PUBLIC_HOST"
paths=$(kubectl -n "$NAMESPACE" get ingress scoringsys -o jsonpath='{range .spec.rules[0].http.paths[*]}{.path}{"\n"}{end}')
expected_paths=$(printf '%s\n%s/\n' "$PUBLIC_PREFIX" "$PUBLIC_PREFIX")
[[ "$paths" == "$expected_paths" ]] || die "Ingress paths do not match PUBLIC_PREFIX"
backend_port=$(kubectl -n "$NAMESPACE" get ingress scoringsys -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.port.number}')
[[ "$backend_port" == "3000" ]] || die "Ingress backend port is not 3000"

PUBLIC_HOST="$PUBLIC_HOST" PUBLIC_PREFIX="$PUBLIC_PREFIX" "$SCRIPT_DIR/smoke-scoringsys.sh"
