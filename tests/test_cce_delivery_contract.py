#!/usr/bin/env python3
"""Offline contract tests for the CCE delivery artifacts."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
CI = (ROOT / ".gitlab-ci.yml").read_text(encoding="utf-8")
DEPLOYMENT_TEMPLATE = (ROOT / "ops/cce/deployment.yaml.tmpl").read_text(encoding="utf-8")
INGRESS_TEMPLATE = (ROOT / "ops/cce/ingress.yaml.tmpl").read_text(encoding="utf-8")


def parse_yaml_documents(path: Path) -> list[dict]:
    return [doc for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")) if doc]


class CceDeliveryContractTest(unittest.TestCase):
    def assert_scan_image_contract(self, pipeline: dict) -> None:
        scan = pipeline["scan-image"]
        self.assertEqual(
            scan["image"],
            {"name": "aquasec/trivy:0.56.2", "entrypoint": [""]},
        )
        self.assertIn('export TRIVY_USERNAME="${SWR_REGION}@${SWR_AK}"', scan["script"])
        self.assertIn('export TRIVY_PASSWORD="$SWR_PASSWORD"', scan["script"])
        self.assertIn(
            'trivy image --severity HIGH,CRITICAL --exit-code 1 "${SWR_REGISTRY}/scoringsys:${CI_COMMIT_SHA}"',
            scan["script"],
        )

    def test_pipeline_has_ordered_stages_and_safe_workflow(self) -> None:
        pipeline = yaml.safe_load(CI)
        self.assertEqual(pipeline["stages"], ["verify", "build", "scan", "deploy", "notify"])
        workflow_text = CI.split("workflow:", 1)[1].split("stages:", 1)[0]
        self.assertIn("merge_request_event", workflow_text)
        self.assertIn("CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH", workflow_text)
        self.assertIn("- when: never", workflow_text)
        self.assertNotIn("docker:dind", CI)
        self.assertNotIn("privileged:", CI)
        self.assertIn("tags:\n    - AI", CI)

    def test_build_scan_deploy_contract(self) -> None:
        pipeline = yaml.safe_load(CI)
        self.assertIn("npm ci", CI)
        self.assertIn("npm test", CI)
        self.assertIn("npm run build", CI)
        self.assertIn("docker buildx build --platform linux/amd64 --provenance=false --push", CI)
        self.assert_scan_image_contract(pipeline)
        deploy = pipeline["deploy-cce"]
        self.assertEqual(deploy["retry"], 0)
        self.assertFalse(deploy["interruptible"])
        self.assertEqual(deploy["resource_group"], "scoringsys-cce")
        self.assertEqual(pipeline["notify-failure"]["when"], "on_failure")
        self.assertTrue(pipeline["notify-failure"]["allow_failure"])
        self.assertNotIn("FEISHU_CHAT_ID", CI)

    def test_workload_is_single_non_root_service_with_real_probes(self) -> None:
        renderer = ROOT / "scripts/ci/render_cce.py"
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ.copy()
            env["IMAGE_REFERENCE"] = "registry.example/scoringsys:test"
            env["KUBE_IMAGE_PULL_SECRET"] = "swr-pull"
            rendered = subprocess.run(["python3", str(renderer), "--output-dir", directory], env=env, text=True, capture_output=True)
            self.assertEqual(rendered.returncode, 0, rendered.stderr)
            documents = parse_yaml_documents(Path(directory) / "deployment.yaml")
        self.assertEqual({doc["kind"] for doc in documents}, {"Deployment", "Service"})
        deployment = documents[0]
        service = documents[1]
        self.assertEqual(deployment["metadata"]["name"], "scoringsys")
        self.assertEqual(service["metadata"]["name"], "scoringsys")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(container["ports"][0]["containerPort"], 3000)
        self.assertEqual(container["readinessProbe"]["httpGet"]["path"], "/scoringsys/")
        self.assertEqual(container["livenessProbe"]["httpGet"]["path"], "/scoringsys/")
        self.assertEqual(container["startupProbe"]["httpGet"]["path"], "/scoringsys/")
        self.assertTrue(deployment["spec"]["template"]["spec"]["securityContext"]["runAsNonRoot"])
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(deployment["spec"]["template"]["spec"]["volumes"][0]["name"], "tmp")
        self.assertEqual(container["volumeMounts"][0]["mountPath"], "/tmp")
        self.assertIn("imagePullSecrets", deployment["spec"]["template"]["spec"])
        self.assertEqual(service["spec"]["ports"][0]["port"], 3000)

    def test_ingress_is_narrow_and_matches_public_constants(self) -> None:
        ingress = parse_yaml_documents(ROOT / "ops/cce/ingress.yaml.tmpl")[0]
        self.assertEqual(ingress["spec"]["ingressClassName"], "cce")
        self.assertEqual(ingress["spec"]["rules"][0]["host"], "nexus.youdoogo.com")
        paths = [entry["path"] for entry in ingress["spec"]["rules"][0]["http"]["paths"]]
        self.assertEqual(paths, ["/scoringsys", "/scoringsys/"])
        self.assertNotIn("/", paths)
        annotations = ingress["metadata"]["annotations"]
        self.assertEqual(annotations["kubernetes.io/elb.id"], "abab7533-a1c6-4138-a4bc-59d53e3446e2")
        self.assertEqual(annotations["kubernetes.io/elb.listener-master-ingress"], "nexus-prod/nexus-studio")
        self.assertEqual(annotations["kubernetes.io/elb.tls-certificate-ids"], "56de20421757445ea53f5af51ecb4e10")

    def test_renderer_rejects_missing_required_input_and_renders_optional_refs(self) -> None:
        renderer = ROOT / "scripts/ci/render_cce.py"
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ.copy()
            env.pop("KUBE_IMAGE_PULL_SECRET", None)
            env["IMAGE_REFERENCE"] = "registry.example/scoringsys:test"
            missing = subprocess.run(["python3", str(renderer), "--output-dir", directory], env=env, text=True, capture_output=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertNotIn("secret-value", missing.stderr)

            env["KUBE_IMAGE_PULL_SECRET"] = "swr-pull"
            env["RUNTIME_SECRET_NAME"] = "scoringsys-runtime"
            env["RUNTIME_CONFIGMAP_NAME"] = "scoringsys-config"
            rendered = subprocess.run(["python3", str(renderer), "--output-dir", directory], env=env, text=True, capture_output=True)
            self.assertEqual(rendered.returncode, 0, rendered.stderr)
            output = (Path(directory) / "deployment.yaml").read_text(encoding="utf-8")
            self.assertIn("secretRef:", output)
            self.assertIn("configMapRef:", output)
            self.assertNotIn("kind: Secret", output)
            self.assertNotIn("kind: ConfigMap", output)

    def test_negative_mutations_fail_contract(self) -> None:
        paths = [entry["path"] for entry in parse_yaml_documents(ROOT / "ops/cce/ingress.yaml.tmpl")[0]["spec"]["rules"][0]["http"]["paths"]]
        self.assertEqual(paths, ["/scoringsys", "/scoringsys/"])
        mutated_paths = paths + ["/"]
        self.assertNotEqual(mutated_paths, ["/scoringsys", "/scoringsys/"])
        self.assertNotIn("--provenance=false", CI.replace("--provenance=false", ""))
        mutated_pipeline = CI.replace("retry: 0", "retry: 1", 1)
        self.assertNotEqual(yaml.safe_load(mutated_pipeline)["deploy-cce"]["retry"], 0)
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["scan-image"]["image"].pop("entrypoint")
        with self.assertRaises(AssertionError):
            self.assert_scan_image_contract(mutated_pipeline)
        self.assertNotIn("kind: Secret", DEPLOYMENT_TEMPLATE)
        self.assertNotIn("kind: ConfigMap", INGRESS_TEMPLATE)


if __name__ == "__main__":
    unittest.main()
