#!/usr/bin/env python3
"""Offline contract tests for the CCE delivery artifacts."""

from __future__ import annotations

import json
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
DEPLOY_SCRIPT = (ROOT / "scripts/ci/deploy-cce.sh").read_text(encoding="utf-8")
SMOKE_SCRIPT = (ROOT / "scripts/ci/smoke-scoringsys.sh").read_text(encoding="utf-8")
NEXT_CONFIG = (ROOT / "next.config.js").read_text(encoding="utf-8")
RENDERER = ROOT / "scripts/ci/render_cce.py"
PUBLIC_PREFIX = "/scoringsys"
FORBIDDEN_SUB_INGRESS_ANNOTATIONS = (
    "kubernetes.io/elb.listen-ports",
    "kubernetes.io/elb.tls-certificate-ids",
    "kubernetes.io/ingress.class",
)


def parse_yaml_documents(path: Path) -> list[dict]:
    return [doc for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")) if doc]


class CceDeliveryContractTest(unittest.TestCase):
    def render(self, template_dir: Path | None = None, **overrides) -> dict[str, list[dict]]:
        """Render the manifests and return the parsed documents by file stem."""
        env = os.environ.copy()
        env["IMAGE_REFERENCE"] = "registry.example/scoringsys:test"
        env["KUBE_IMAGE_PULL_SECRET"] = "swr-pull"
        env["RECONCILE_TRIGGER"] = "test-trigger"
        for key, value in overrides.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        with tempfile.TemporaryDirectory() as directory:
            command = ["python3", str(RENDERER), "--output-dir", directory]
            if template_dir is not None:
                command += ["--template-dir", str(template_dir)]
            result = subprocess.run(command, env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return {
                stem: parse_yaml_documents(Path(directory) / f"{stem}.yaml")
                for stem in ("deployment", "ingress")
            }

    def render_expecting_failure(self, template_dir: Path, **overrides) -> str:
        env = os.environ.copy()
        env["IMAGE_REFERENCE"] = "registry.example/scoringsys:test"
        env["KUBE_IMAGE_PULL_SECRET"] = "swr-pull"
        env["RECONCILE_TRIGGER"] = "test-trigger"
        env.update(overrides)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                ["python3", str(RENDERER), "--output-dir", directory, "--template-dir", str(template_dir)],
                env=env,
                text=True,
                capture_output=True,
            )
        self.assertNotEqual(result.returncode, 0, "renderer accepted a manifest it should have rejected")
        return result.stderr

    def mutated_templates(self, directory: str, ingress_transform) -> Path:
        """Copy the real templates into `directory`, rewriting the Ingress."""
        template_dir = Path(directory)
        (template_dir / "deployment.yaml.tmpl").write_text(DEPLOYMENT_TEMPLATE, encoding="utf-8")
        (template_dir / "ingress.yaml.tmpl").write_text(ingress_transform(INGRESS_TEMPLATE), encoding="utf-8")
        return template_dir

    def assert_scan_image_contract(self, pipeline: dict) -> None:
        scan = pipeline["scan-image"]
        variables = scan["variables"]
        script = scan["script"]
        db_download = next(command for command in script if command.startswith("download_trivy_db()"))
        scan_command = next(command for command in script if command.startswith("trivy image --severity"))
        self.assertEqual(
            scan["image"],
            {"name": "aquasec/trivy:0.56.2", "entrypoint": [""]},
        )
        self.assertEqual(
            variables["TRIVY_DB_REPOSITORY_PRIMARY"],
            "mirror.gcr.io/aquasec/trivy-db:2",
        )
        self.assertEqual(
            variables["TRIVY_DB_REPOSITORY_FALLBACK"],
            "ghcr.io/aquasecurity/trivy-db:2",
        )
        self.assertNotEqual(
            variables["TRIVY_DB_REPOSITORY_PRIMARY"],
            variables["TRIVY_DB_REPOSITORY_FALLBACK"],
        )
        self.assertEqual(variables["TRIVY_DB_DOWNLOAD_TIMEOUT"], "5m")
        self.assertEqual(variables["TRIVY_CACHE_DIR"], ".trivycache")
        self.assertEqual(
            scan["cache"],
            {
                "key": "trivy-0.56.2-db-v2",
                "paths": [".trivycache/"],
                "policy": "pull-push",
                "when": "always",
            },
        )
        self.assertNotIn("$", scan["cache"]["key"])
        self.assertNotIn("PASSWORD", json.dumps(scan["cache"]))

        self.assertIn('TRIVY_DB_REPOSITORY="$repository" trivy image', db_download)
        self.assertIn("--download-db-only", db_download)
        self.assertIn('--cache-dir "$TRIVY_CACHE_DIR"', db_download)
        self.assertIn('--timeout "$TRIVY_DB_DOWNLOAD_TIMEOUT"', db_download)
        self.assertIn('download_trivy_db "$TRIVY_DB_REPOSITORY_PRIMARY"', db_download)
        self.assertIn('elif download_trivy_db "$TRIVY_DB_REPOSITORY_FALLBACK"', db_download)
        self.assertLess(
            db_download.index("TRIVY_DB_REPOSITORY_PRIMARY"),
            db_download.index("TRIVY_DB_REPOSITORY_FALLBACK"),
        )
        self.assertIn("exit 1", db_download)
        self.assertNotIn("--skip-db-update", db_download)

        self.assertIn("unset TRIVY_USERNAME TRIVY_PASSWORD", script)
        self.assertIn('export TRIVY_USERNAME="${SWR_REGION}@${SWR_AK}"', script)
        self.assertIn('export TRIVY_PASSWORD="$SWR_PASSWORD"', script)
        self.assertLess(script.index(db_download), script.index('export TRIVY_USERNAME="${SWR_REGION}@${SWR_AK}"'))
        self.assertEqual(
            scan_command,
            'trivy image --severity HIGH,CRITICAL --exit-code 1 --cache-dir "$TRIVY_CACHE_DIR" '
            '--skip-db-update --skip-java-db-update "${SWR_REGISTRY}/scoringsys:${CI_COMMIT_SHA}"',
        )
        self.assertLess(script.index(db_download), script.index(scan_command))
        self.assertEqual("\n".join(script).count("--skip-db-update"), 1)
        self.assertNotIn("--ignore", "\n".join(script))
        self.assertNotIn("allow_failure", scan)

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
        self.assertEqual(container["readinessProbe"]["httpGet"]["path"], PUBLIC_PREFIX)
        self.assertEqual(container["livenessProbe"]["httpGet"]["path"], PUBLIC_PREFIX)
        self.assertEqual(container["startupProbe"]["httpGet"]["path"], PUBLIC_PREFIX)
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
        path_entries = ingress["spec"]["rules"][0]["http"]["paths"]
        paths = [entry["path"] for entry in path_entries]
        self.assertEqual(paths, ["/scoringsys"])
        self.assertEqual(path_entries[0]["pathType"], "Prefix")
        self.assertEqual(path_entries[0]["backend"]["service"]["name"], "scoringsys")
        self.assertEqual(path_entries[0]["backend"]["service"]["port"]["number"], 3000)
        self.assertNotIn("/", paths)
        annotations = ingress["metadata"]["annotations"]
        self.assertEqual(annotations["kubernetes.io/elb.class"], "performance")
        self.assertEqual(annotations["kubernetes.io/elb.id"], "abab7533-a1c6-4138-a4bc-59d53e3446e2")
        self.assertEqual(annotations["kubernetes.io/elb.port"], "80")
        self.assertEqual(annotations["kubernetes.io/elb.listener-master-ingress"], "nexus-prod/nexus-studio")
        self.assertEqual(annotations["reconcile-trigger"], "{{RECONCILE_TRIGGER}}")
        # The shared listener (ports 80/443 + certificate) belongs to the master
        # Ingress; a sub-ingress that declares any of these fights it for the
        # listener definition or selects the controller through a deprecated path.
        for forbidden in FORBIDDEN_SUB_INGRESS_ANNOTATIONS:
            self.assertNotIn(forbidden, annotations)

    def test_deploy_applies_scoring_ingress_without_delete_recreate_race(self) -> None:
        # Deleting the Ingress and immediately re-applying it races the CCE
        # controller's asynchronous ELB cleanup: the delete's forwarding-policy
        # teardown can land after the recreate's policy generation, leaving a
        # healthy-looking Ingress with no ELB route. Apply must be idempotent and
        # the reconcile must be driven by the reconcile-trigger annotation.
        self.assertNotIn("delete ingress", DEPLOY_SCRIPT)
        self.assertNotIn("delete deployment", DEPLOY_SCRIPT)
        self.assertNotIn("delete service", DEPLOY_SCRIPT)

        ingress_dry_run = DEPLOY_SCRIPT.index('apply --dry-run=server -f "$ingress"')
        endpoints_ready = DEPLOY_SCRIPT.index('[[ -n "${addresses:-}" ]] || die "Service has no ready endpoints"')
        ingress_apply = DEPLOY_SCRIPT.index('apply -f "$ingress"')
        trigger_check = DEPLOY_SCRIPT.index("applied_trigger=")
        smoke = DEPLOY_SCRIPT.index("smoke-scoringsys.sh")
        self.assertLess(endpoints_ready, ingress_dry_run)
        self.assertLess(ingress_dry_run, ingress_apply)
        self.assertLess(ingress_apply, trigger_check)
        self.assertLess(trigger_check, smoke)

    def test_deploy_gates_forbidden_shared_listener_annotations(self) -> None:
        for forbidden in FORBIDDEN_SUB_INGRESS_ANNOTATIONS:
            self.assertIn(forbidden, DEPLOY_SCRIPT)
        self.assertIn("Ingress must not declare $forbidden on the shared listener", DEPLOY_SCRIPT)
        self.assertIn("rolled out image does not match IMAGE_REFERENCE", DEPLOY_SCRIPT)

    def test_smoke_asserts_the_real_trailing_slash_direction(self) -> None:
        # Next.js runs with basePath=/scoringsys and trailingSlash=false, so
        # /scoringsys is the canonical 200 and /scoringsys/ is what 308s onto it.
        # The smoke previously asserted the mirror image of this and could never
        # pass, so pin the direction down in both directions here.
        self.assertNotIn("trailingSlash", NEXT_CONFIG)
        redirect_check = SMOKE_SCRIPT.split("check_trailing_slash_redirect()", 1)[1].split("check_page_and_asset()", 1)[0]
        self.assertIn('request_status "$slashed_url"', redirect_check)
        self.assertIn("301|302|307|308)", redirect_check)
        self.assertIn('"$(location_path "$location")" == "$PUBLIC_PREFIX"', redirect_check)

        page_check = SMOKE_SCRIPT.split("check_page_and_asset()", 1)[1].split("run_bounded_check()", 1)[0]
        self.assertIn('request_status "$canonical_url"', page_check)
        self.assertIn('if [[ "$status" != "200" ]]', page_check)
        self.assertIn("SMOKE_HTML_MARKER", page_check)
        self.assertIn("static asset unexpectedly returned HTML", page_check)

        self.assertIn("canonical_url=\"${base_url}${PUBLIC_PREFIX}\"", SMOKE_SCRIPT)
        self.assertIn('slashed_url="${canonical_url}/"', SMOKE_SCRIPT)
        self.assertIn("run_bounded_check page-and-static-asset check_page_and_asset", SMOKE_SCRIPT)
        self.assertIn("run_bounded_check trailing-slash-redirect check_trailing_slash_redirect", SMOKE_SCRIPT)

    def test_smoke_retries_transient_statuses_without_corrupting_the_code(self) -> None:
        # curl still emits %{http_code} on a transport failure, so an appended
        # `|| printf '000'` produced "000000" and no transient branch matched it.
        self.assertNotIn("\"$url\" 2>/dev/null || printf '000'", SMOKE_SCRIPT)
        self.assertIn('|| status=""', SMOKE_SCRIPT)
        self.assertIn("[0-9][0-9][0-9]) printf '%s' \"$status\"", SMOKE_SCRIPT)
        # 404 covers the window where the ELB policy is not published yet and the
        # shared listener's "/" catch-all answers; 503 covers backend warm-up.
        self.assertIn("000|404|502|503) return 0", SMOKE_SCRIPT)

    def test_smoke_keeps_tls_verification_and_uses_the_configured_prefix(self) -> None:
        # Comments are allowed to name the flags they forbid; only executable
        # lines may not weaken certificate verification.
        executable = "\n".join(
            line for line in SMOKE_SCRIPT.splitlines() if not line.lstrip().startswith("#")
        )
        for weakening in ("--insecure", " -k ", "--proto-default http:", "GIT_SSL_NO_VERIFY"):
            self.assertNotIn(weakening, executable)
        # The asset assertion must follow PUBLIC_PREFIX rather than hard-coding it.
        self.assertIn('${prefix_pattern}/_next/static/', SMOKE_SCRIPT)
        self.assertNotIn("'/scoringsys/_next/static/", SMOKE_SCRIPT)

    def test_built_app_matches_the_smoke_contract(self) -> None:
        # Belt-and-braces: when a build is present, confirm the smoke direction
        # against what Next.js actually emitted rather than against the config.
        manifest = ROOT / ".next/routes-manifest.json"
        if not manifest.exists():
            self.skipTest("no Next.js build present")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertEqual(data["basePath"], PUBLIC_PREFIX)
        redirects = {(item["source"], item["destination"]) for item in data.get("redirects", [])}
        self.assertIn((f"{PUBLIC_PREFIX}/", PUBLIC_PREFIX), redirects)

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

    def test_renderer_enforces_shared_elb_contract_on_the_rendered_ingress(self) -> None:
        ingress = self.render()["ingress"][0]
        annotations = ingress["metadata"]["annotations"]
        self.assertEqual(annotations["kubernetes.io/elb.class"], "performance")
        self.assertEqual(annotations["kubernetes.io/elb.id"], "abab7533-a1c6-4138-a4bc-59d53e3446e2")
        self.assertEqual(annotations["kubernetes.io/elb.port"], "80")
        self.assertEqual(annotations["kubernetes.io/elb.listener-master-ingress"], "nexus-prod/nexus-studio")
        self.assertEqual(annotations["reconcile-trigger"], "test-trigger")
        for forbidden in FORBIDDEN_SUB_INGRESS_ANNOTATIONS:
            self.assertNotIn(forbidden, annotations)

    def test_renderer_rejects_sub_ingress_claiming_the_shared_listener(self) -> None:
        injections = {
            "kubernetes.io/elb.listen-ports": '\'[{"HTTP":80},{"HTTPS":443}]\'',
            "kubernetes.io/elb.tls-certificate-ids": "56de20421757445ea53f5af51ecb4e10",
            "kubernetes.io/ingress.class": "cce",
        }
        for key, value in injections.items():
            with self.subTest(annotation=key), tempfile.TemporaryDirectory() as directory:
                template_dir = self.mutated_templates(
                    directory,
                    lambda text: text.replace(
                        "    kubernetes.io/elb.class: performance",
                        f"    {key}: {value}\n    kubernetes.io/elb.class: performance",
                    ),
                )
                stderr = self.render_expecting_failure(template_dir)
                self.assertIn(key, stderr)

    def test_renderer_rejects_drifted_elb_target_and_probe_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            template_dir = self.mutated_templates(directory, lambda text: text)
            # A CI variable pointing at a different ELB than the template must fail
            # the render instead of silently publishing to the wrong load balancer.
            stderr = self.render_expecting_failure(template_dir, CCE_ELB_ID="00000000-0000-0000-0000-000000000000")
            self.assertIn("kubernetes.io/elb.id", stderr)

        with tempfile.TemporaryDirectory() as directory:
            template_dir = Path(directory)
            (template_dir / "ingress.yaml.tmpl").write_text(INGRESS_TEMPLATE, encoding="utf-8")
            # A probe on the slashed form only ever sees the Next.js 308, which
            # kubelet accepts as success -- Ready without a rendered page.
            (template_dir / "deployment.yaml.tmpl").write_text(
                DEPLOYMENT_TEMPLATE.replace("path: /scoringsys", "path: /scoringsys/"), encoding="utf-8"
            )
            stderr = self.render_expecting_failure(template_dir)
            self.assertIn("does not match PUBLIC_PREFIX", stderr)

    def test_negative_mutations_fail_contract(self) -> None:
        paths = [entry["path"] for entry in parse_yaml_documents(ROOT / "ops/cce/ingress.yaml.tmpl")[0]["spec"]["rules"][0]["http"]["paths"]]
        self.assertEqual(paths, ["/scoringsys"])
        mutated_paths = paths + ["/"]
        self.assertNotEqual(mutated_paths, ["/scoringsys"])
        self.assertNotIn("--provenance=false", CI.replace("--provenance=false", ""))
        mutated_pipeline = CI.replace("retry: 0", "retry: 1", 1)
        self.assertNotEqual(yaml.safe_load(mutated_pipeline)["deploy-cce"]["retry"], 0)
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["scan-image"]["image"].pop("entrypoint")
        with self.assertRaises(AssertionError):
            self.assert_scan_image_contract(mutated_pipeline)
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["scan-image"]["variables"]["TRIVY_DB_REPOSITORY_PRIMARY"] = "ghcr.io/aquasecurity/trivy-db:2"
        with self.assertRaises(AssertionError):
            self.assert_scan_image_contract(mutated_pipeline)
        mutated_pipeline = yaml.safe_load(CI.replace('--timeout "$TRIVY_DB_DOWNLOAD_TIMEOUT"', "", 1))
        with self.assertRaises(AssertionError):
            self.assert_scan_image_contract(mutated_pipeline)
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["scan-image"]["cache"]["paths"] = [".different-cache/"]
        with self.assertRaises(AssertionError):
            self.assert_scan_image_contract(mutated_pipeline)
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["scan-image"]["allow_failure"] = True
        with self.assertRaises(AssertionError):
            self.assert_scan_image_contract(mutated_pipeline)
        self.assertNotIn("kind: Secret", DEPLOYMENT_TEMPLATE)
        self.assertNotIn("kind: ConfigMap", INGRESS_TEMPLATE)


if __name__ == "__main__":
    unittest.main()
