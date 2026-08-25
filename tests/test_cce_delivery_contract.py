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
SMOKE_SCRIPT = (ROOT / "scripts/ci/smoke-scoringsys.sh").read_text(encoding="utf-8")


def parse_yaml_documents(path: Path) -> list[dict]:
    return [doc for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")) if doc]


class CceDeliveryContractTest(unittest.TestCase):
    def run_smoke_with_statuses(self, statuses: list[str], attempts: int = 2):
        with tempfile.TemporaryDirectory() as directory:
            temp_dir = Path(directory)
            fake_curl = temp_dir / "curl"
            fake_curl.write_text(
                """#!/usr/bin/env python3
from pathlib import Path
import os
import sys

args = sys.argv[1:]
headers = next(args[index + 1] for index, arg in enumerate(args) if arg == "--dump-header")
output = next(args[index + 1] for index, arg in enumerate(args) if arg == "--output")
url = args[-1]
state_path = Path(os.environ["FAKE_CURL_STATE"])
log_path = Path(os.environ["FAKE_CURL_LOG"])
statuses = os.environ["FAKE_CURL_STATUSES"].split(",")
request_number = int(state_path.read_text())
status = statuses[min(request_number, len(statuses) - 1)]
state_path.write_text(str(request_number + 1))
with log_path.open("a", encoding="utf-8") as log:
    log.write(url + "\\n")
if status == "000":
    raise SystemExit(7)

content_type = ""
if "_next/static/" in url:
    content_type = "application/javascript"
elif url.endswith("/scoringsys/"):
    content_type = "text/html"
Path(headers).write_text(
    f"HTTP/1.1 {status}\\n"
    + (f"Location: /scoringsys/\\n" if status in {"301", "302", "307", "308"} else "")
    + (f"Content-Type: {content_type}\\n" if content_type else "")
    + "\\n",
    encoding="utf-8",
)
if output != "/dev/null" and status == "200":
    body = "立项评审在线打分系统 /scoringsys/_next/static/chunks/app.js" if url.endswith("/scoringsys/") else "asset"
    Path(output).write_text(body, encoding="utf-8")
print(status, end="")
""",
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            state_path = temp_dir / "state"
            state_path.write_text("0", encoding="utf-8")
            log_path = temp_dir / "requests.log"
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{temp_dir}:{env['PATH']}",
                    "PUBLIC_HOST": "example.test",
                    "PUBLIC_PREFIX": "/scoringsys",
                    "SMOKE_ATTEMPTS": str(attempts),
                    "SMOKE_DELAY_SECONDS": "0",
                    "FAKE_CURL_STATE": str(state_path),
                    "FAKE_CURL_LOG": str(log_path),
                    "FAKE_CURL_STATUSES": ",".join(statuses),
                }
            )
            result = subprocess.run(["bash", str(ROOT / "scripts/ci/smoke-scoringsys.sh")], env=env, text=True, capture_output=True)
            requests = log_path.read_text(encoding="utf-8").splitlines() if log_path.exists() else []
            return result, requests

    def assert_scan_image_contract(self, pipeline: dict) -> None:
        scan = pipeline["scan-image"]
        self.assertEqual(
            scan["image"],
            {"name": "aquasec/trivy:0.56.2", "entrypoint": [""]},
        )
        self.assertEqual(
            scan["variables"]["TRIVY_DB_REPOSITORY"],
            "m.daocloud.io/ghcr.io/aquasecurity/trivy-db:2",
        )
        self.assertEqual(
            scan["variables"]["TRIVY_JAVA_DB_REPOSITORY"],
            "m.daocloud.io/ghcr.io/aquasecurity/trivy-java-db:1",
        )
        self.assertNotEqual(
            scan["variables"]["TRIVY_DB_REPOSITORY"],
            "ghcr.io/aquasecurity/trivy-db:2",
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
        self.assertEqual(annotations["kubernetes.io/elb.class"], "performance")
        self.assertEqual(annotations["kubernetes.io/elb.id"], "abab7533-a1c6-4138-a4bc-59d53e3446e2")
        self.assertEqual(annotations["kubernetes.io/elb.port"], "80")
        self.assertEqual(annotations["kubernetes.io/elb.listener-master-ingress"], "nexus-prod/nexus-studio")
        self.assertNotIn("kubernetes.io/elb.listen-ports", annotations)
        self.assertNotIn("kubernetes.io/elb.tls-certificate-ids", annotations)

    def test_canonical_redirect_retries_only_transient_statuses(self) -> None:
        canonical_check = SMOKE_SCRIPT.split("check_canonical_redirect()", 1)[1].split("check_page_and_asset()", 1)[0]
        self.assertIn("301|302|307|308)", canonical_check)
        self.assertIn("000|404|502)", canonical_check)
        self.assertIn("return 10", canonical_check)
        self.assertIn("canonical URL returned HTTP %s", canonical_check)
        self.assertIn("return 1", canonical_check)
        self.assertIn("run_bounded_check canonical-redirect check_canonical_redirect", SMOKE_SCRIPT)
        self.assertIn("SMOKE_HTML_MARKER", SMOKE_SCRIPT)
        self.assertIn("static asset unexpectedly returned HTML", SMOKE_SCRIPT)

    def test_canonical_redirect_transient_retry_preserves_page_contract(self) -> None:
        for transient_status in ("000", "404", "502"):
            with self.subTest(status=transient_status):
                result, requests = self.run_smoke_with_statuses([transient_status, "302", "200", "200"])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("canonical-redirect passed on attempt 2", result.stdout)
                self.assertEqual(len(requests), 4)

    def test_canonical_redirect_rejects_non_redirect_without_retry(self) -> None:
        result, requests = self.run_smoke_with_statuses(["200"], attempts=2)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("canonical URL returned HTTP 200", result.stderr)
        self.assertEqual(requests, ["https://example.test/scoringsys"])

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
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["scan-image"]["variables"]["TRIVY_DB_REPOSITORY"] = "ghcr.io/aquasecurity/trivy-db:2"
        with self.assertRaises(AssertionError):
            self.assert_scan_image_contract(mutated_pipeline)
        self.assertNotIn("kind: Secret", DEPLOYMENT_TEMPLATE)
        self.assertNotIn("kind: ConfigMap", INGRESS_TEMPLATE)


if __name__ == "__main__":
    unittest.main()
