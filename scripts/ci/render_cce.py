#!/usr/bin/env python3
"""Render and validate the narrowly scoped CCE manifests."""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError as exc:  # pragma: no cover - exercised by CI setup failures
    raise SystemExit("PyYAML is required to render CCE manifests") from exc


PUBLIC_HOST = os.environ.get("PUBLIC_HOST", "").strip() or "nexus.youdoogo.com"
PUBLIC_PREFIX = os.environ.get("PUBLIC_PREFIX", "").strip() or "/scoringsys"
CCE_ELB_ID = os.environ.get("CCE_ELB_ID", "").strip() or "abab7533-a1c6-4138-a4bc-59d53e3446e2"
CCE_LISTENER_MASTER_INGRESS = (
    os.environ.get("CCE_LISTENER_MASTER_INGRESS", "").strip() or "nexus-prod/nexus-studio"
)
CCE_ELB_PORT = os.environ.get("CCE_ELB_PORT", "").strip() or "80"
CCE_ELB_CLASS = os.environ.get("CCE_ELB_CLASS", "").strip() or "performance"
CCE_INGRESS_CLASS = os.environ.get("CCE_INGRESS_CLASS", "").strip() or "cce"
DEFAULT_POSTGRES_SERVICE_NAME = "postgres"
NAME_PATTERN = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
TRIGGER_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,63}$")
LABEL_KEY_PATTERN = re.compile(
    r"^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?/)?"
    r"[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$"
)
LABEL_VALUE_PATTERN = re.compile(r"^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$")

# The listener on the shared nexus-prod ELB (ports 80/443 plus the TLS certificate)
# is owned by the master Ingress. A sub-ingress that declares these annotations
# fights the master for the listener definition, so they must never be rendered.
FORBIDDEN_INGRESS_ANNOTATIONS = (
    "kubernetes.io/elb.listen-ports",
    "kubernetes.io/elb.tls-certificate-ids",
    # Deprecated selector. Every working cce Ingress in nexus-prod selects the
    # controller through spec.ingressClassName only; carrying both is the single
    # configuration difference that set scoringsys apart from its working peers.
    "kubernetes.io/ingress.class",
    # CCE derives this annotation from named backends. Declaring it would make the
    # manifest depend on the controller path that leaves this shared ELB at 404.
    "ingress.kubernetes.io/named-ports",
)


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def validate_name(name: str, value: str) -> str:
    if not NAME_PATTERN.fullmatch(value) or len(value) > 63:
        raise ValueError(f"{name} must be a DNS-compatible name")
    return value


def validate_label_key(value: str) -> str:
    if not LABEL_KEY_PATTERN.fullmatch(value):
        raise ValueError("POSTGRES_POD_LABEL_KEY must be a safe Kubernetes label key")
    return value


def validate_label_value(name: str, value: str) -> str:
    if not LABEL_VALUE_PATTERN.fullmatch(value):
        raise ValueError(f"{name} must be a safe Kubernetes label value")
    return value


def render_runtime_env(secret_name: str | None, configmap_name: str | None) -> str:
    refs = []
    if secret_name:
        refs.append(f"          - secretRef:\n              name: {secret_name}")
    if configmap_name:
        refs.append(f"          - configMapRef:\n              name: {configmap_name}")
    if not refs:
        return ""
    return "          envFrom:\n" + "\n".join(refs)


def render_template(template: str, values: dict[str, str]) -> str:
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", value)
    if "{{" in rendered or "}}" in rendered:
        raise ValueError("template contains an unresolved placeholder")
    return rendered


def parse_documents(content: str, expected_kinds: set[str]) -> list[dict]:
    try:
        documents = [doc for doc in yaml.safe_load_all(content) if doc is not None]
    except yaml.YAMLError as exc:
        raise ValueError("rendered manifest is not valid YAML") from exc
    if {doc.get("kind") for doc in documents} != expected_kinds:
        raise ValueError("rendered manifest has an unexpected resource set")
    if any(doc.get("kind") in {"Secret", "ConfigMap"} for doc in documents):
        raise ValueError("templates must not create Secrets or ConfigMaps")
    return documents


def build_values() -> dict[str, str]:
    namespace = validate_name("KUBE_NAMESPACE", os.environ.get("KUBE_NAMESPACE", "nexus-prod").strip() or "nexus-prod")
    pull_secret = validate_name("KUBE_IMAGE_PULL_SECRET", required("KUBE_IMAGE_PULL_SECRET"))
    image = os.environ.get("IMAGE_REFERENCE", "").strip()
    if not image:
        registry = required("SWR_REGISTRY")
        commit = required("CI_COMMIT_SHA")
        image = f"{registry.rstrip('/')}/scoringsys:{commit}"
    if any(char.isspace() for char in image) or "\n" in image:
        raise ValueError("IMAGE_REFERENCE must not contain whitespace")

    trigger = os.environ.get("RECONCILE_TRIGGER", "").strip()
    if not trigger:
        pipeline_id = os.environ.get("CI_PIPELINE_ID", "").strip()
        job_id = os.environ.get("CI_JOB_ID", "").strip()
        if pipeline_id and job_id:
            trigger = f"{pipeline_id}-{job_id}"
        else:
            trigger = pipeline_id or os.environ.get("CI_COMMIT_SHA", "").strip() or "local"
    if not TRIGGER_PATTERN.fullmatch(trigger):
        raise ValueError("RECONCILE_TRIGGER must be a short alphanumeric token")

    # Runtime credentials are always supplied out-of-band. Requiring the
    # reference here prevents a rendered Deployment that starts without a DB
    # URL, and keeps the renderer from ever creating or selecting a Secret.
    secret_name = validate_name("RUNTIME_SECRET_NAME", required("RUNTIME_SECRET_NAME"))
    configmap_name = os.environ.get("RUNTIME_CONFIGMAP_NAME", "").strip() or None
    if configmap_name:
        validate_name("RUNTIME_CONFIGMAP_NAME", configmap_name)

    migrator_secret_name = validate_name(
        "MIGRATOR_SECRET_NAME",
        os.environ.get("MIGRATOR_SECRET_NAME", "").strip() or "scoringsys-migrator",
    )
    if migrator_secret_name == secret_name:
        raise ValueError("MIGRATOR_SECRET_NAME must be independent from RUNTIME_SECRET_NAME")

    # This is an informational annotation; the enforced database destination is
    # the required pod selector below. Keep the established service convention
    # usable when the render job has no project-level service-name variable.
    postgres_service_name = validate_name(
        "POSTGRES_SERVICE_NAME",
        os.environ.get("POSTGRES_SERVICE_NAME", "").strip() or DEFAULT_POSTGRES_SERVICE_NAME,
    )
    postgres_label_key = validate_label_key(required("POSTGRES_POD_LABEL_KEY"))
    postgres_label_value = validate_label_value("POSTGRES_POD_LABEL_VALUE", required("POSTGRES_POD_LABEL_VALUE"))
    db_pool_max_raw = os.environ.get("DB_POOL_MAX", "10").strip() or "10"
    if not db_pool_max_raw.isdigit() or int(db_pool_max_raw) < 1:
        raise ValueError("DB_POOL_MAX must be a positive integer")
    db_pool_max = int(db_pool_max_raw)

    return {
        "NAMESPACE": namespace,
        "IMAGE_PULL_SECRET": pull_secret,
        "IMAGE_REFERENCE": image,
        "RUNTIME_SECRET_NAME": secret_name,
        "RUNTIME_ENV_BLOCK": render_runtime_env(secret_name, configmap_name),
        "MIGRATOR_SECRET_NAME": migrator_secret_name,
        "POSTGRES_SERVICE_NAME": postgres_service_name,
        "POSTGRES_POD_LABEL_KEY": postgres_label_key,
        "POSTGRES_POD_LABEL_VALUE": postgres_label_value,
        "DB_POOL_MAX": str(db_pool_max),
        "RECONCILE_TRIGGER": trigger,
    }


def validate_probe_paths(deployment: dict) -> None:
    """Keep the container probes on the same public prefix the Ingress exposes.

    A probe on "{prefix}/" only ever observes the Next.js 308 that normalises the
    trailing slash away, and kubectl treats 3xx as success -- so the workload can
    report Ready without the page having rendered once.
    """
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
        path = container[probe]["httpGet"]["path"]
        if path != PUBLIC_PREFIX:
            raise ValueError(f"{probe} path {path} does not match PUBLIC_PREFIX {PUBLIC_PREFIX}")


def validate_service_port(service: dict) -> None:
    """Keep the Service on the numeric target contract used by working CCE peers."""
    ports = service["spec"].get("ports") or []
    expected = {"name": "http", "port": 3000, "targetPort": 3000}
    actual = {key: ports[0].get(key) for key in expected} if len(ports) == 1 else None
    if actual != expected:
        raise ValueError("Service port must be exactly name=http, port=3000, targetPort=3000")


def validate_shared_elb_annotations(ingress: dict, trigger: str) -> None:
    """Enforce the sub-ingress contract for the shared nexus-prod ELB."""
    annotations = ingress["metadata"].get("annotations") or {}
    expected = {
        "kubernetes.io/elb.class": CCE_ELB_CLASS,
        "kubernetes.io/elb.id": CCE_ELB_ID,
        "kubernetes.io/elb.port": str(CCE_ELB_PORT),
        "kubernetes.io/elb.listener-master-ingress": CCE_LISTENER_MASTER_INGRESS,
        "reconcile-trigger": trigger,
    }
    for key, want in expected.items():
        got = annotations.get(key)
        if str(got) != want:
            raise ValueError(f"Ingress annotation {key} must be {want}")
    for key in FORBIDDEN_INGRESS_ANNOTATIONS:
        if key in annotations:
            raise ValueError(f"Ingress must not declare {key} on a shared-listener sub-ingress")


def render(output_dir: Path, template_dir: Path) -> None:
    values = build_values()
    output_dir.mkdir(parents=True, exist_ok=True)
    deployment = render_template((template_dir / "deployment.yaml.tmpl").read_text(encoding="utf-8"), values)
    ingress = render_template((template_dir / "ingress.yaml.tmpl").read_text(encoding="utf-8"), values)
    migrate = render_template((template_dir / "job-migrate.yaml.tmpl").read_text(encoding="utf-8"), values)
    importer = render_template((template_dir / "job-import.yaml.tmpl").read_text(encoding="utf-8"), values)
    networkpolicy = render_template((template_dir / "networkpolicy.yaml.tmpl").read_text(encoding="utf-8"), values)
    deployment_docs = parse_documents(deployment, {"Deployment", "Service"})
    ingress_docs = parse_documents(ingress, {"Ingress"})
    migrate_docs = parse_documents(migrate, {"Job"})
    import_docs = parse_documents(importer, {"Job"})
    networkpolicy_docs = parse_documents(networkpolicy, {"NetworkPolicy"})

    deployment_obj = deployment_docs[0]
    service_obj = deployment_docs[1]
    if deployment_obj["metadata"]["namespace"] != values["NAMESPACE"] or service_obj["metadata"]["namespace"] != values["NAMESPACE"]:
        raise ValueError("workload namespace does not match KUBE_NAMESPACE")
    validate_probe_paths(deployment_obj)
    validate_service_port(service_obj)
    forbidden_hosted_client = "".join(("SUP", "ABASE"))
    if forbidden_hosted_client in deployment.upper():
        raise ValueError("Deployment must not reference hosted database credentials")
    web_container = deployment_obj["spec"]["template"]["spec"]["containers"][0]
    web_pod_spec = deployment_obj["spec"]["template"]["spec"]
    if web_pod_spec.get("automountServiceAccountToken") is not False:
        raise ValueError("web Deployment must not mount a ServiceAccount token")
    env_from = web_container.get("envFrom") or []
    secret_refs = [ref.get("secretRef", {}).get("name") for ref in env_from if ref.get("secretRef")]
    if secret_refs != [values["RUNTIME_SECRET_NAME"]]:
        raise ValueError("web Deployment must reference only RUNTIME_SECRET_NAME as a Secret")
    configmap_refs = [ref.get("configMapRef", {}).get("name") for ref in env_from if ref.get("configMapRef")]
    expected_configmaps = [os.environ["RUNTIME_CONFIGMAP_NAME"].strip()] if os.environ.get("RUNTIME_CONFIGMAP_NAME", "").strip() else []
    if configmap_refs != expected_configmaps:
        raise ValueError("web Deployment ConfigMap references must match RUNTIME_CONFIGMAP_NAME")
    if any(name == values["MIGRATOR_SECRET_NAME"] for name in secret_refs):
        raise ValueError("web Deployment must not reference the migrator Secret")
    replicas = deployment_obj.get("spec", {}).get("replicas", 1)
    if not isinstance(replicas, int) or replicas < 1 or replicas * int(values["DB_POOL_MAX"]) > 40:
        raise ValueError("replicas x DB_POOL_MAX must be a positive value no greater than 40")

    ingress_obj = ingress_docs[0]
    if ingress_obj["spec"].get("ingressClassName") != CCE_INGRESS_CLASS:
        raise ValueError(f"Ingress must use ingressClassName {CCE_INGRESS_CLASS}")
    paths = ingress_obj["spec"]["rules"][0]["http"]["paths"]
    if [path["path"] for path in paths] != [PUBLIC_PREFIX]:
        raise ValueError(f"Ingress must expose only {PUBLIC_PREFIX}")
    if ingress_obj["spec"]["rules"][0]["host"] != PUBLIC_HOST:
        raise ValueError("Ingress host does not match the public contract")
    backend_port = paths[0]["backend"]["service"].get("port")
    if backend_port != {"number": 3000}:
        raise ValueError("Ingress backend service port must be exactly {number: 3000}")
    validate_shared_elb_annotations(ingress_obj, values["RECONCILE_TRIGGER"])

    for job_docs in (migrate_docs, import_docs):
        job = job_docs[0]
        if job["metadata"].get("namespace") != values["NAMESPACE"]:
            raise ValueError("Job namespace does not match KUBE_NAMESPACE")
        job_spec = job.get("spec") or {}
        if job_spec.get("backoffLimit") != 0 or job_spec.get("ttlSecondsAfterFinished") != 86400:
            raise ValueError("database Jobs must have backoffLimit=0 and ttlSecondsAfterFinished=86400")
        pod_spec = (job_spec.get("template") or {}).get("spec") or {}
        if pod_spec.get("restartPolicy") != "Never":
            raise ValueError("database Jobs must use restartPolicy Never")
        if pod_spec.get("automountServiceAccountToken") is not False:
            raise ValueError("database Jobs must not mount a ServiceAccount token")
        containers = pod_spec.get("containers") or []
        if len(containers) != 1:
            raise ValueError("database Jobs must have exactly one container")
        container = containers[0]
        security = container.get("securityContext") or {}
        if (
            security.get("readOnlyRootFilesystem") is not True
            or security.get("runAsNonRoot") is not True
            or security.get("runAsUser") != 1000
            or security.get("allowPrivilegeEscalation") is not False
            or security.get("capabilities", {}).get("drop") != ["ALL"]
        ):
            raise ValueError("database Jobs must use the non-root read-only security baseline")
        env_from = container.get("envFrom") or []
        if env_from != [{"secretRef": {"name": values["MIGRATOR_SECRET_NAME"]}}]:
            raise ValueError("database Jobs must use only the independent migrator Secret")
        resources = container.get("resources") or {}
        if not all(resources.get(section, {}).get(key) for section in ("requests", "limits") for key in ("cpu", "memory")):
            raise ValueError("database Jobs must declare resource requests and limits")
        if not any(volume.get("name") == "tmp" for volume in pod_spec.get("volumes", [])):
            raise ValueError("database Jobs must mount an emptyDir /tmp")

    policy = networkpolicy_docs[0]
    if policy["metadata"].get("namespace") != values["NAMESPACE"]:
        raise ValueError("NetworkPolicy namespace does not match KUBE_NAMESPACE")
    if (policy["metadata"].get("annotations") or {}).get("scoringsys.io/postgres-service") != values["POSTGRES_SERVICE_NAME"]:
        raise ValueError("NetworkPolicy postgres Service reference is not rendered")
    expected_selector = {values["POSTGRES_POD_LABEL_KEY"]: values["POSTGRES_POD_LABEL_VALUE"]}
    rules = policy.get("spec", {}).get("egress") or []
    expected_rules = [
        {
            "to": [{"podSelector": {"matchLabels": expected_selector}}],
            "ports": [{"protocol": "TCP", "port": 5432}],
        },
        {
            "to": [{"namespaceSelector": {}}],
            "ports": [{"protocol": "UDP", "port": 53}],
        },
        {
            "to": [{"namespaceSelector": {}}],
            "ports": [{"protocol": "TCP", "port": 53}],
        },
    ]
    if rules != expected_rules:
        raise ValueError("NetworkPolicy must allow only postgres TCP 5432 and UDP/TCP DNS")
    if policy.get("spec", {}).get("policyTypes") != ["Egress"]:
        raise ValueError("NetworkPolicy must declare Egress policy type")

    (output_dir / "deployment.yaml").write_text(deployment, encoding="utf-8")
    (output_dir / "ingress.yaml").write_text(ingress, encoding="utf-8")
    (output_dir / "job-migrate.yaml").write_text(migrate, encoding="utf-8")
    (output_dir / "job-import.yaml").write_text(importer, encoding="utf-8")
    (output_dir / "networkpolicy.yaml").write_text(networkpolicy, encoding="utf-8")
    print(f"Rendered CCE manifests to {output_dir}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(".rendered/cce"))
    parser.add_argument("--template-dir", type=Path, default=Path(__file__).resolve().parents[2] / "ops/cce")
    args = parser.parse_args()
    try:
        render(args.output_dir, args.template_dir)
    except (OSError, ValueError, KeyError) as exc:
        print(f"CCE render failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
