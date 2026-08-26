#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=${CI_PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/../.." && pwd)}
RENDERED_DIR=${RENDERED_DIR:-"$PROJECT_DIR/.rendered/cce"}
NAMESPACE=${KUBE_NAMESPACE:-nexus-prod}
PUBLIC_HOST=${PUBLIC_HOST:-nexus.youdoogo.com}
PUBLIC_PREFIX=${PUBLIC_PREFIX:-/scoringsys}
CCE_ELB_CLASS=${CCE_ELB_CLASS:-performance}
CCE_ELB_ID=${CCE_ELB_ID:-abab7533-a1c6-4138-a4bc-59d53e3446e2}
CCE_ELB_PORT=${CCE_ELB_PORT:-80}
CCE_LISTENER_MASTER_INGRESS=${CCE_LISTENER_MASTER_INGRESS:-nexus-prod/nexus-studio}
RECONCILE_PROPAGATION_SECONDS=${RECONCILE_PROPAGATION_SECONDS:-5}

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

get_ingress_annotation() {
  local namespace=$1
  local name=$2
  local key=$3
  local template

  # Annotation keys are fixed below; keep the template argument data-only even
  # if this helper is reused later with a value from outside the script.
  [[ "$key" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "invalid Ingress annotation key"
  printf -v template '{{ with index .metadata.annotations "%s" }}{{ . }}{{ end }}' "$key"
  kubectl -n "$namespace" get ingress "$name" -o "go-template=$template" 2>/dev/null || true
}

readonly ANNOTATION_ELB_CLASS='kubernetes.io/elb.class'
readonly ANNOTATION_ELB_ID='kubernetes.io/elb.id'
readonly ANNOTATION_ELB_PORT='kubernetes.io/elb.port'
readonly ANNOTATION_ELB_LISTENER_MASTER='kubernetes.io/elb.listener-master-ingress'
readonly ANNOTATION_RECONCILE_TRIGGER='reconcile-trigger'
readonly ANNOTATION_FORBIDDEN_LISTEN_PORTS='kubernetes.io/elb.listen-ports'
readonly ANNOTATION_FORBIDDEN_TLS_CERTIFICATES='kubernetes.io/elb.tls-certificate-ids'
readonly ANNOTATION_FORBIDDEN_INGRESS_CLASS='kubernetes.io/ingress.class'

[[ -n "${KUBECONFIG_CCE_B64:-}" ]] || die "KUBECONFIG_CCE_B64 is required"
[[ -n "${KUBE_IMAGE_PULL_SECRET:-}" ]] || die "KUBE_IMAGE_PULL_SECRET is required"
[[ ${#NAMESPACE} -le 63 && "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || die "KUBE_NAMESPACE is not DNS-compatible"
[[ "$RECONCILE_PROPAGATION_SECONDS" =~ ^[0-9]+$ ]] || die "RECONCILE_PROPAGATION_SECONDS must be a non-negative integer"

# CCE_LISTENER_MASTER_INGRESS is a frozen namespace/name contract. Parse it as
# two DNS names before any cluster mutation and require the listener owner to be
# in the same namespace as the child. This keeps shell metacharacters, extra
# path segments and cross-namespace targets out of the annotate command.
if [[ ! "$CCE_LISTENER_MASTER_INGRESS" =~ ^([^/]+)/([^/]+)$ ]]; then
  die "CCE_LISTENER_MASTER_INGRESS must be namespace/name"
fi
master_namespace=${BASH_REMATCH[1]}
master_name=${BASH_REMATCH[2]}
[[ ${#master_namespace} -le 63 && "$master_namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || die "master Ingress namespace is not DNS-compatible"
[[ ${#master_name} -le 63 && "$master_name" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || die "master Ingress name is not DNS-compatible"
[[ "$master_namespace" == "$NAMESPACE" ]] || die "master Ingress namespace must match KUBE_NAMESPACE"

workload="$RENDERED_DIR/deployment.yaml"
ingress="$RENDERED_DIR/ingress.yaml"
if [[ ! -s "$workload" || ! -s "$ingress" ]]; then
  require_command python3
  IMAGE_REFERENCE=${IMAGE_REFERENCE:-} python3 "$SCRIPT_DIR/render_cce.py" --output-dir "$RENDERED_DIR" || die "manifest rendering failed"
fi
[[ -s "$workload" && -s "$ingress" ]] || die "rendered manifests are missing"

kubeconfig=$(mktemp)
trap 'rm -f "$kubeconfig"' EXIT
printf '%s' "$KUBECONFIG_CCE_B64" | base64 -d >"$kubeconfig" || die "invalid KUBECONFIG_CCE_B64"
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

# The Ingress is applied, never deleted-then-recreated. The CCE controller drives
# the ELB through asynchronous cloud-side calls, so a delete immediately followed
# by an apply can land the delete's forwarding-policy cleanup AFTER the recreate's
# policy generation. That leaves a healthy-looking Ingress -- status.loadBalancer
# populated, a successful CREATE event -- with no ELB route at all, and nothing
# resyncs it afterwards. The rendered manifest instead carries a per-pipeline
# reconcile-trigger annotation, which is how the other sub-ingresses on this
# shared ELB (nexus-prod/des-game, nexus-prod/nexus-studio) force a re-reconcile.
kubectl -n "$NAMESPACE" apply --dry-run=server -f "$ingress" >/dev/null || die "Ingress server dry-run failed"
kubectl -n "$NAMESPACE" apply -f "$ingress" >/dev/null || die "Ingress apply failed"

host=$(kubectl -n "$NAMESPACE" get ingress scoringsys -o jsonpath='{.spec.rules[0].host}')
[[ "$host" == "$PUBLIC_HOST" ]] || die "Ingress host does not match PUBLIC_HOST"
paths=$(kubectl -n "$NAMESPACE" get ingress scoringsys -o jsonpath='{range .spec.rules[0].http.paths[*]}{.path}{"\n"}{end}')
expected_paths=$(printf '%s\n' "$PUBLIC_PREFIX")
[[ "$paths" == "$expected_paths" ]] || die "Ingress paths do not match PUBLIC_PREFIX"
backend_port=$(kubectl -n "$NAMESPACE" get ingress scoringsys -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.port.number}')
[[ "$backend_port" == "3000" ]] || die "Ingress backend port is not 3000"

child_elb_class=$(get_ingress_annotation "$NAMESPACE" scoringsys "$ANNOTATION_ELB_CLASS")
[[ "$child_elb_class" == "$CCE_ELB_CLASS" ]] || die "Ingress ELB class does not match the shared-listener contract"
child_elb_id=$(get_ingress_annotation "$NAMESPACE" scoringsys "$ANNOTATION_ELB_ID")
[[ "$child_elb_id" == "$CCE_ELB_ID" ]] || die "Ingress ELB id does not match the shared-listener contract"
child_elb_port=$(get_ingress_annotation "$NAMESPACE" scoringsys "$ANNOTATION_ELB_PORT")
[[ "$child_elb_port" == "$CCE_ELB_PORT" ]] || die "Ingress ELB port does not match the shared-listener contract"
child_master=$(get_ingress_annotation "$NAMESPACE" scoringsys "$ANNOTATION_ELB_LISTENER_MASTER")
[[ "$child_master" == "$CCE_LISTENER_MASTER_INGRESS" ]] || die "Ingress listener master does not match CCE_LISTENER_MASTER_INGRESS"

# The listener on the shared ELB belongs to the master Ingress. Fail closed if a
# stale or hand-edited object still claims the listener or the deprecated class
# selector, rather than letting it reach the ELB.
for forbidden in \
  "$ANNOTATION_FORBIDDEN_LISTEN_PORTS" \
  "$ANNOTATION_FORBIDDEN_TLS_CERTIFICATES" \
  "$ANNOTATION_FORBIDDEN_INGRESS_CLASS"; do
  value=$(get_ingress_annotation "$NAMESPACE" scoringsys "$forbidden")
  [[ -z "$value" ]] || die "Ingress must not declare $forbidden on the shared listener"
done

applied_trigger=$(get_ingress_annotation "$NAMESPACE" scoringsys "$ANNOTATION_RECONCILE_TRIGGER")
[[ "$applied_trigger" =~ ^[A-Za-z0-9._-]{1,63}$ ]] || die "Ingress has an invalid reconcile-trigger annotation"

running_image=$(kubectl -n "$NAMESPACE" get deployment scoringsys -o jsonpath='{.spec.template.spec.containers[0].image}')
if [[ -n "${IMAGE_REFERENCE:-}" && "$running_image" != "$IMAGE_REFERENCE" ]]; then
  die "rolled out image does not match IMAGE_REFERENCE"
fi

# Prefer the deploy job's unique token so a retried deploy still changes the
# master annotation. This follows render_cce.py's RECONCILE_TRIGGER contract;
# when CI identifiers are unavailable, the already-validated child token keeps
# local/offline execution non-empty and bounded.
master_trigger=${RECONCILE_TRIGGER:-}
if [[ -z "$master_trigger" && -n "${CI_PIPELINE_ID:-}" && -n "${CI_JOB_ID:-}" ]]; then
  master_trigger="${CI_PIPELINE_ID}-${CI_JOB_ID}"
fi
master_trigger=${master_trigger:-$applied_trigger}
[[ "$master_trigger" =~ ^[A-Za-z0-9._-]{1,63}$ ]] || die "master reconcile-trigger is invalid"

# Updating the child does not necessarily refresh the shared listener policy.
# The master owns that listener, so trigger one controller reconcile with the
# deploy token after the child contract has been verified. This is
# annotation-only: the master manifest, TLS/listen-port settings and spec are
# never applied, patched or deleted.
kubectl -n "$master_namespace" annotate ingress "$master_name" "reconcile-trigger=$master_trigger" --overwrite >/dev/null || die "master Ingress reconcile annotation failed"
master_applied_trigger=$(get_ingress_annotation "$master_namespace" "$master_name" "$ANNOTATION_RECONCILE_TRIGGER")
[[ "$master_applied_trigger" == "$master_trigger" ]] || die "master Ingress reconcile-trigger was not updated"
sleep "$RECONCILE_PROPAGATION_SECONDS"

PUBLIC_HOST="$PUBLIC_HOST" PUBLIC_PREFIX="$PUBLIC_PREFIX" "$SCRIPT_DIR/smoke-scoringsys.sh"
