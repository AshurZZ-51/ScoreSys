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


PUBLIC_HOST = "nexus.youdoogo.com"
PUBLIC_PREFIX = "/scoringsys"
CCE_ELB_ID = "abab7533-a1c6-4138-a4bc-59d53e3446e2"
CCE_LISTENER_MASTER_INGRESS = "nexus-prod/nexus-studio"
CCE_TLS_CERTIFICATE_IDS = "56de20421757445ea53f5af51ecb4e10"
CCE_INGRESS_CLASS = "cce"
NAME_PATTERN = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def validate_name(name: str, value: str) -> str:
    if not NAME_PATTERN.fullmatch(value) or len(value) > 63:
        raise ValueError(f"{name} must be a DNS-compatible name")
    return value


def render_runtime_env(secret_name: str | None, configmap_name: str | None) -> str:
    refs = []
    if secret_name:
        refs.append(f"        - secretRef:\n            name: {secret_name}")
    if configmap_name:
        refs.append(f"        - configMapRef:\n            name: {configmap_name}")
    if not refs:
        return ""
    return "      envFrom:\n" + "\n".join(refs)


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

    secret_name = os.environ.get("RUNTIME_SECRET_NAME", "").strip() or None
    configmap_name = os.environ.get("RUNTIME_CONFIGMAP_NAME", "").strip() or None
    if secret_name:
        validate_name("RUNTIME_SECRET_NAME", secret_name)
    if configmap_name:
        validate_name("RUNTIME_CONFIGMAP_NAME", configmap_name)

    return {
        "NAMESPACE": namespace,
        "IMAGE_PULL_SECRET": pull_secret,
        "IMAGE_REFERENCE": image,
        "RUNTIME_ENV_BLOCK": render_runtime_env(secret_name, configmap_name),
    }


def render(output_dir: Path, template_dir: Path) -> None:
    values = build_values()
    output_dir.mkdir(parents=True, exist_ok=True)
    deployment = render_template((template_dir / "deployment.yaml.tmpl").read_text(encoding="utf-8"), values)
    ingress = render_template((template_dir / "ingress.yaml.tmpl").read_text(encoding="utf-8"), values)
    deployment_docs = parse_documents(deployment, {"Deployment", "Service"})
    ingress_docs = parse_documents(ingress, {"Ingress"})

    deployment_obj = deployment_docs[0]
    service_obj = deployment_docs[1]
    if deployment_obj["metadata"]["namespace"] != values["NAMESPACE"] or service_obj["metadata"]["namespace"] != values["NAMESPACE"]:
        raise ValueError("workload namespace does not match KUBE_NAMESPACE")
    ingress_obj = ingress_docs[0]
    if ingress_obj["spec"].get("ingressClassName") != CCE_INGRESS_CLASS:
        raise ValueError("Ingress must use ingressClassName cce")
    paths = ingress_obj["spec"]["rules"][0]["http"]["paths"]
    if [path["path"] for path in paths] != [PUBLIC_PREFIX, PUBLIC_PREFIX + "/"]:
        raise ValueError("Ingress must expose only /scoringsys and /scoringsys/")
    if ingress_obj["spec"]["rules"][0]["host"] != PUBLIC_HOST:
        raise ValueError("Ingress host does not match the public contract")

    (output_dir / "deployment.yaml").write_text(deployment, encoding="utf-8")
    (output_dir / "ingress.yaml").write_text(ingress, encoding="utf-8")
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
