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
CCE_TEMPLATE_STEMS = ("deployment", "ingress", "networkpolicy")
DEPLOY_SCRIPT = (ROOT / "scripts/ci/deploy-cce.sh").read_text(encoding="utf-8")
SMOKE_SCRIPT = (ROOT / "scripts/ci/smoke-scoringsys.sh").read_text(encoding="utf-8")
NEXT_CONFIG = (ROOT / "next.config.js").read_text(encoding="utf-8")
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
RENDERER = ROOT / "scripts/ci/render_cce.py"
PUBLIC_PREFIX = "/scoringsys"
FORBIDDEN_SUB_INGRESS_ANNOTATIONS = (
    "kubernetes.io/elb.listen-ports",
    "kubernetes.io/elb.tls-certificate-ids",
    "kubernetes.io/ingress.class",
    "ingress.kubernetes.io/named-ports",
)
FATAL_LIVE_INGRESS_ANNOTATIONS = FORBIDDEN_SUB_INGRESS_ANNOTATIONS[:3]


def parse_yaml_documents(path: Path) -> list[dict]:
    return [doc for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")) if doc]


def shell_commands(script: list[str]) -> str:
    """Join a job's script, dropping comment lines.

    Assertions must describe what the runner executes. A comment that merely
    names a forbidden flag is not a use of it.
    """
    lines = "\n".join(script).splitlines()
    return "\n".join(line for line in lines if not line.lstrip().startswith("#"))


class CceDeliveryContractTest(unittest.TestCase):
    def render(self, template_dir: Path | None = None, **overrides) -> dict[str, list[dict]]:
        """Render the manifests and return the parsed documents by file stem."""
        env = os.environ.copy()
        env["IMAGE_REFERENCE"] = "registry.example/scoringsys:test"
        env["KUBE_IMAGE_PULL_SECRET"] = "swr-pull"
        env["RUNTIME_SECRET_NAME"] = "scoringsys-runtime"
        env["POSTGRES_SERVICE_NAME"] = "postgres"
        env["POSTGRES_POD_LABEL_KEY"] = "app"
        env["POSTGRES_POD_LABEL_VALUE"] = "postgres"
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
                for stem in CCE_TEMPLATE_STEMS
            }

    def render_expecting_failure(self, template_dir: Path, **overrides) -> str:
        env = os.environ.copy()
        env["IMAGE_REFERENCE"] = "registry.example/scoringsys:test"
        env["KUBE_IMAGE_PULL_SECRET"] = "swr-pull"
        env["RUNTIME_SECRET_NAME"] = "scoringsys-runtime"
        env["POSTGRES_SERVICE_NAME"] = "postgres"
        env["POSTGRES_POD_LABEL_KEY"] = "app"
        env["POSTGRES_POD_LABEL_VALUE"] = "postgres"
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

    def ci_lint_script(self) -> str:
        pipeline = yaml.safe_load(CI)
        return "\n".join(pipeline["ci-lint"]["script"])

    def run_ci_lint(self, body: str, status: str = "200", curl_exit: int = 0) -> subprocess.CompletedProcess:
        """Run the CI-lint job script against a deterministic curl stub."""
        curl_stub = r'''#!/bin/sh
set -eu
args_file=${CURL_ARGS_FILE:?}
printf '%s\n' "$@" > "$args_file"
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --write-out|--header|--form) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$output" ]; then
  printf '%s' "${CURL_BODY:-}" > "$output"
else
  printf '%s' "${CURL_BODY:-}"
fi
printf '%s' "$CURL_STATUS"
exit "${CURL_EXIT:-0}"
'''
        with tempfile.TemporaryDirectory() as directory:
            command_dir = Path(directory)
            curl_path = command_dir / "curl"
            curl_path.write_text(curl_stub, encoding="utf-8")
            curl_path.chmod(0o755)
            args_file = command_dir / "curl-args"
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{command_dir}:{env.get('PATH', '')}",
                    "CI_API_V4_URL": "https://gitlab.example/api/v4",
                    "CI_PROJECT_ID": "123",
                    "CI_JOB_TOKEN": "runner-secret",
                    "CURL_ARGS_FILE": str(args_file),
                    "CURL_BODY": body,
                    "CURL_STATUS": status,
                    "CURL_EXIT": str(curl_exit),
                }
            )
            result = subprocess.run(["sh"], input=self.ci_lint_script(), env=env, text=True, capture_output=True)
            result.curl_args = args_file.read_text(encoding="utf-8") if args_file.exists() else ""
            return result

    def mutated_templates(self, directory: str, ingress_transform) -> Path:
        """Copy the real templates into `directory`, rewriting the Ingress."""
        template_dir = Path(directory)
        (template_dir / "deployment.yaml.tmpl").write_text(DEPLOYMENT_TEMPLATE, encoding="utf-8")
        (template_dir / "ingress.yaml.tmpl").write_text(ingress_transform(INGRESS_TEMPLATE), encoding="utf-8")
        for stem in ("networkpolicy",):
            source = ROOT / "ops/cce" / f"{stem}.yaml.tmpl"
            if source.exists():
                (template_dir / f"{stem}.yaml.tmpl").write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        return template_dir

    def trivy_db_setup_script(self) -> str:
        pipeline = yaml.safe_load(CI)
        return next(command for command in pipeline["scan-image"]["script"] if "cleanup_trivy_db_partial()" in command)

    def run_trivy_db_setup(self, repository: str = "", suffix: str = "") -> subprocess.CompletedProcess:
        script = self.trivy_db_setup_script().split("if ! download_trivy_db", 1)[0] + suffix
        with tempfile.TemporaryDirectory() as cache_dir:
            env = os.environ.copy()
            env.update(
                {
                    "SWR_REGION": "test-region",
                    "SWR_AK": "test-ak",
                    "SWR_PASSWORD": "test-password",
                    "SWR_REGISTRY": "swr.test.example",
                    "TRIVY_CACHE_DIR": cache_dir,
                    "TRIVY_DB_DOWNLOAD_TIMEOUT": "5m",
                    "TRIVY_DB_REPOSITORY": repository,
                }
            )
            return subprocess.run(["sh"], input=script, env=env, text=True, capture_output=True)

    def run_build_retry(self, docker_stub: str) -> subprocess.CompletedProcess:
        """Execute the real retry loop against a stubbed `docker`."""
        pipeline = yaml.safe_load(CI)
        block = next(c for c in pipeline["build-image"]["script"] if "build_image()" in c)
        with tempfile.TemporaryDirectory() as directory:
            stub = Path(directory) / "docker"
            stub.write_text(docker_stub, encoding="utf-8")
            stub.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{directory}:{env['PATH']}",
                    "SWR_REGISTRY": "swr.test.example",
                    "BUILD_CACHE_REF": "swr.test.example/scoringsys:buildcache-main",
                    "CI_COMMIT_SHA": "deadbeef",
                    "ATTEMPT_LOG": str(Path(directory) / "attempts"),
                }
            )
            # `sleep` is stubbed out so the test does not actually wait.
            return subprocess.run(
                ["sh"], input="sleep() { :; }\n" + block, env=env, text=True, capture_output=True
            )

    def test_build_retry_is_bounded_and_still_fails_the_job(self) -> None:
        always_fails = '#!/bin/sh\nprintf x >> "$ATTEMPT_LOG"\nexit 1\n'
        result = self.run_build_retry(always_fails)
        self.assertEqual(result.returncode, 1, "an unbuildable image must fail the job")
        self.assertIn("failed after 2 attempts", result.stderr)
        self.assertEqual(result.stdout.count("docker buildx build (attempt"), 2)

        recovers = (
            '#!/bin/sh\nprintf x >> "$ATTEMPT_LOG"\n'
            '[ "$(wc -c < "$ATTEMPT_LOG")" -ge 2 ] || exit 1\nexit 0\n'
        )
        result = self.run_build_retry(recovers)
        self.assertEqual(result.returncode, 0, "a transient mirror failure must be retried")
        self.assertEqual(result.stdout.count("docker buildx build (attempt"), 2)
        self.assertNotIn("failed after 2 attempts", result.stderr)

    def assert_scan_image_contract(self, pipeline: dict) -> None:
        scan = pipeline["scan-image"]
        variables = scan["variables"]
        script = scan["script"]
        db_download = next(command for command in script if "download_trivy_db()" in command)
        scan_command = next(command for command in script if command.startswith("trivy image --severity"))
        self.assertEqual(
            scan["image"],
            {"name": "aquasec/trivy:0.56.2", "entrypoint": [""]},
        )
        self.assertEqual(variables["TRIVY_DB_REPOSITORY"], "public.ecr.aws/aquasecurity/trivy-db:2")
        self.assertEqual(variables["TRIVY_DB_DOWNLOAD_TIMEOUT"], "5m")
        self.assertEqual(variables["TRIVY_CACHE_DIR"], ".trivycache")
        self.assertEqual(
            scan["cache"],
            {
                "key": "trivy-0.56.2-db-v2",
                "unprotect": True,
                "paths": [".trivycache/"],
                "policy": "pull-push",
                "when": "always",
            },
        )
        self.assertNotIn("$", scan["cache"]["key"])
        self.assertNotIn("PASSWORD", json.dumps(scan["cache"]))

        self.assertIn('repository="$TRIVY_DB_REPOSITORY"', db_download)
        self.assertIn('export TRIVY_DB_REPOSITORY="${TRIVY_DB_REPOSITORY:-public.ecr.aws/aquasecurity/trivy-db:2}"', db_download)
        self.assertIn("trivy image", db_download)
        self.assertIn("--download-db-only", db_download)
        self.assertIn('--cache-dir "$TRIVY_CACHE_DIR"', db_download)
        self.assertIn('--timeout "$TRIVY_DB_DOWNLOAD_TIMEOUT"', db_download)
        self.assertEqual(db_download.count("--download-db-only"), 1)
        self.assertEqual(db_download.count('--cache-dir "$TRIVY_CACHE_DIR"'), 1)
        self.assertEqual(db_download.count('--timeout "$TRIVY_DB_DOWNLOAD_TIMEOUT"'), 1)
        self.assertIn('while [ "$attempt" -le 2 ]', db_download)
        self.assertIn('attempt=$((attempt + 1))', db_download)
        self.assertIn('sleep 2', db_download)
        self.assertIn("cleanup_trivy_db_partial", db_download)
        self.assertIn("-name 'trivy.db.tmp'", db_download)
        self.assertIn("-name 'metadata.json.tmp'", db_download)
        self.assertNotIn('rm -rf "$TRIVY_CACHE_DIR"', db_download)
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
        self.assertNotIn("mirror.gcr.io", db_download)
        self.assertNotIn("ghcr.io", db_download)

    def assert_build_cache_contract(self, pipeline: dict, dockerfile: str) -> None:
        """The CI caches must cut download time without weakening any gate."""
        verify = pipeline["verify-app"]
        verify_script = shell_commands(verify["script"])
        build = pipeline["build-image"]
        build_script = shell_commands(build["script"])
        after_script = shell_commands(build.get("after_script", []))

        # verify-app keeps a real lockfile-keyed npm cache and still runs the
        # full test and build commands.
        self.assertEqual(verify["variables"]["npm_config_cache"], "$CI_PROJECT_DIR/.npm")
        self.assertEqual(verify["cache"]["key"], {"files": ["package-lock.json"]})
        self.assertEqual(verify["cache"]["paths"], [".npm/"])
        self.assertEqual(verify["cache"]["policy"], "pull-push")
        self.assertIn("npm ci --prefer-offline", verify_script)
        self.assertIn("npm test", verify_script)
        self.assertIn("npm run build", verify_script)
        # A cache must never be allowed to stand in for the lockfile check.
        self.assertNotIn("npm install", verify_script)
        self.assertNotIn("--no-package-lock", verify_script)
        self.assertNotIn("allow_failure", verify)

        # The builder is per-job and is torn down again: jobs 14147 and 14164
        # showed a shared name does not survive between jobs on this runner,
        # so it bought no cache and only risked concurrent config drift.
        self.assertIn("${CI_JOB_ID}", build["variables"]["BUILDX_BUILDER"])
        self.assertIn('docker buildx rm "${BUILDX_BUILDER:-}"', after_script)

        # The cross-pipeline cache is a registry cache in SWR, on a tag that is
        # distinct from the immutable commit tag it must never overwrite.
        cache_tag = build["variables"]["BUILD_CACHE_TAG"]
        self.assertNotIn("CI_COMMIT_SHA", cache_tag)
        self.assertIn('export BUILD_CACHE_REF="${SWR_REGISTRY}/scoringsys:${BUILD_CACHE_TAG}"', build_script)
        self.assertIn('--cache-from "type=registry,ref=${BUILD_CACHE_REF}"', build_script)
        self.assertIn("--cache-to \"type=registry,ref=${BUILD_CACHE_REF},mode=max,", build_script)
        self.assertIn('--tag "${SWR_REGISTRY}/scoringsys:${CI_COMMIT_SHA}"', build_script)
        # The cache must never be written to the commit tag.
        self.assertNotIn("ref=${SWR_REGISTRY}/scoringsys:${CI_COMMIT_SHA}", build_script)

        # --pull is forbidden: it forces a fresh base-image resolution. It was
        # not the only cause -- job 14164 fell through to registry-1.docker.io
        # without it -- but it removes one guaranteed upstream request.
        self.assertNotIn("--pull", build_script)

        # The whole build is retried at most twice for the intermittent mirror,
        # and a final failure must still fail the job.
        self.assertIn('while [ "$attempt" -le 2 ]', build_script)
        self.assertIn("attempt=$((attempt + 1))", build_script)
        self.assertIn("sleep 10", build_script)
        self.assertIn("exit 1", build_script)
        # Retrying must never turn into swallowing the failure.
        self.assertNotIn("docker buildx build --platform linux/amd64 --provenance=false --push || true", build_script)
        self.assertNotIn("|| true", build_script.split("build_image()")[1].split("docker logout")[0])

        # Because the cache may now hold the base image for a long time, the
        # two controls that keep a stale base from shipping must both hold.
        # 1. OpenSSL packages are re-upgraded once a day.
        self.assertIn("APK_UPGRADE_DATE=$(date -u +%Y-%m-%d)", build_script)
        self.assertIn("ARG APK_UPGRADE_DATE", dockerfile)
        self.assertIn("${APK_UPGRADE_DATE}", dockerfile)
        self.assertIn("apk upgrade --no-cache libcrypto3 libssl3", dockerfile)
        # 2. Trivy still blocks on any HIGH/CRITICAL CVE the base image carries,
        #    so staleness can only ever fail the pipeline, never ship silently.
        scan = pipeline["scan-image"]
        self.assertNotIn("allow_failure", scan)
        self.assertIn(
            "--severity HIGH,CRITICAL --exit-code 1",
            "\n".join(scan["script"]),
        )
        self.assertIn({"job": "scan-image"}, pipeline["deploy-cce"]["needs"])

        # The image build reuses npm's download cache but still installs from
        # the lockfile.
        self.assertIn("--mount=type=cache,target=/root/.npm,sharing=locked", dockerfile)
        self.assertIn("npm ci --prefer-offline", dockerfile)
        self.assertNotIn("npm install", dockerfile)
        self.assertIn("npm run build", dockerfile)

    def test_build_caches_are_fast_without_weakening_the_gates(self) -> None:
        self.assert_build_cache_contract(yaml.safe_load(CI), DOCKERFILE)

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
        self.assertIn({"job": "scan-image"}, deploy["needs"])
        self.assertEqual(pipeline["notify-failure"]["when"], "on_failure")
        self.assertEqual(pipeline["notify-success"]["when"], "on_success")
        self.assertEqual(pipeline["notify-success"]["needs"], [{"job": "deploy-cce"}])
        for job_name, status in (("notify-failure", "failure"), ("notify-success", "success")):
            job = pipeline[job_name]
            self.assertEqual(job["image"], "python:3.12-alpine")
            self.assertTrue(job["allow_failure"])
            script = "\n".join(job["script"])
            self.assertIn("FEISHU_APP_ID", script)
            self.assertIn("FEISHU_APP_SECRET", script)
            self.assertIn("FEISHU_CHAT_ID", script)
            self.assertIn(f"python3 scripts/ci/notify_feishu.py --status {status}", script)
            self.assertNotIn("|| true", script)
            self.assertIn("CI_PIPELINE_SOURCE != \"merge_request_event\"", job["rules"][0]["if"])
        self.assertNotIn("FEISHU_WEBHOOK_URL", CI)

    def test_render_requires_runtime_secret_without_migrator_inputs(self) -> None:
        pipeline = yaml.safe_load(CI)
        render_script = shell_commands(pipeline["render-cce"]["script"])
        self.assertIn(': "${RUNTIME_SECRET_NAME:?RUNTIME_SECRET_NAME is required}"', render_script)
        self.assertNotIn(': "${MIGRATOR_SECRET_NAME:?MIGRATOR_SECRET_NAME is required}"', render_script)
        self.assertNotIn("MIGRATOR_SECRET_NAME", RENDERER.read_text(encoding="utf-8"))

        with self.assertRaises(AssertionError) as failure:
            self.render(
                RUNTIME_SECRET_NAME=None,
                POSTGRES_SERVICE_NAME="postgres",
                POSTGRES_POD_LABEL_KEY="app.kubernetes.io/name",
                POSTGRES_POD_LABEL_VALUE="postgres",
            )
        self.assertIn("RUNTIME_SECRET_NAME", str(failure.exception))

    def test_render_is_self_contained_for_known_postgres_selector(self) -> None:
        pipeline = yaml.safe_load(CI)
        render_script = shell_commands(pipeline["render-cce"]["script"])
        self.assertNotIn(': "${MIGRATOR_SECRET_NAME:?MIGRATOR_SECRET_NAME is required}"', render_script)
        self.assertNotIn(': "${POSTGRES_SERVICE_NAME:?POSTGRES_SERVICE_NAME is required}"', render_script)

        env = os.environ.copy()
        for name in (
            "POSTGRES_SERVICE_NAME",
            "POSTGRES_POD_LABEL_KEY",
            "POSTGRES_POD_LABEL_VALUE",
        ):
            env.pop(name, None)
        env.update({name: str(value) for name, value in pipeline["variables"].items()})
        env.update(
            {
                "SWR_REGION": "test-region",
                "CI_COMMIT_SHA": "deadbeef",
                "KUBE_IMAGE_PULL_SECRET": "swr-pull",
                "RUNTIME_SECRET_NAME": "scoringsys-runtime",
            }
        )
        script = "\n".join(
            command
            for command in pipeline["render-cce"]["script"]
            if not command.startswith("python -m pip install")
        )
        with tempfile.TemporaryDirectory() as directory:
            script = script.replace(
                "python scripts/ci/render_cce.py --output-dir .rendered/cce",
                f"python {RENDERER} --output-dir {directory}",
            )
            result = subprocess.run(["sh"], input=script, env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            policy = parse_yaml_documents(Path(directory) / "networkpolicy.yaml")[0]
        self.assertEqual(policy["metadata"]["annotations"]["scoringsys.io/postgres-service"], "postgres")
        postgres_rule = next(rule for rule in policy["spec"]["egress"] if rule["ports"][0]["port"] == 5432)
        self.assertEqual(
            postgres_rule["to"],
            [{"podSelector": {"matchLabels": {"statefulset.kubernetes.io/pod-name": "postgres-0"}}}],
        )

        env["IMAGE_REFERENCE"] = "swr.test-region.myhuaweicloud.com/scoringsys:deadbeef"
        for missing_name in ("POSTGRES_POD_LABEL_KEY", "POSTGRES_POD_LABEL_VALUE"):
            with self.subTest(missing_name=missing_name), tempfile.TemporaryDirectory() as directory:
                renderer_env = env.copy()
                renderer_env.pop(missing_name)
                result = subprocess.run(
                    ["python3", str(RENDERER), "--output-dir", directory],
                    env=renderer_env,
                    text=True,
                    capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(missing_name, result.stderr)

    def test_ci_lint_accepts_valid_project_response_with_job_token(self) -> None:
        result = self.run_ci_lint('{"valid":true}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("https://gitlab.example/api/v4/projects/123/ci/lint", result.curl_args)
        self.assertIn("JOB-TOKEN: runner-secret", result.curl_args)
        self.assertNotIn("runner-secret", result.stdout + result.stderr)

    def test_ci_lint_fails_when_reachable_api_rejects_yaml(self) -> None:
        for status in ("200", "400"):
            with self.subTest(status=status):
                result = self.run_ci_lint('{"valid":false,"errors":["invalid config"]}', status=status)
                self.assertEqual(result.returncode, 1)
                self.assertIn("rejected", result.stderr)
                self.assertNotIn("invalid config", result.stdout + result.stderr)

    def test_ci_lint_marks_404_and_transport_failure_as_unavailable(self) -> None:
        for status, curl_exit in (("404", 0), ("000", 7)):
            with self.subTest(status=status, curl_exit=curl_exit):
                result = self.run_ci_lint('{"message":"unavailable"}', status=status, curl_exit=curl_exit)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("unavailable", result.stderr)
                self.assertNotIn("rejected", result.stderr)

    def test_workload_is_single_non_root_service_with_real_probes(self) -> None:
        renderer = ROOT / "scripts/ci/render_cce.py"
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ.copy()
            env["IMAGE_REFERENCE"] = "registry.example/scoringsys:test"
            env["KUBE_IMAGE_PULL_SECRET"] = "swr-pull"
            env["RUNTIME_SECRET_NAME"] = "scoringsys-runtime"
            env["POSTGRES_SERVICE_NAME"] = "postgres"
            env["POSTGRES_POD_LABEL_KEY"] = "app"
            env["POSTGRES_POD_LABEL_VALUE"] = "postgres"
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
        self.assertFalse(deployment["spec"]["template"]["spec"]["automountServiceAccountToken"])
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(deployment["spec"]["template"]["spec"]["volumes"][0]["name"], "tmp")
        self.assertEqual(container["volumeMounts"][0]["mountPath"], "/tmp")
        self.assertIn("imagePullSecrets", deployment["spec"]["template"]["spec"])
        self.assertEqual(service["spec"]["ports"][0]["name"], "http")
        self.assertEqual(service["spec"]["ports"][0]["port"], 3000)
        self.assertEqual(service["spec"]["ports"][0]["targetPort"], 3000)

    def test_ingress_is_narrow_and_matches_public_constants(self) -> None:
        ingress = parse_yaml_documents(ROOT / "ops/cce/ingress.yaml.tmpl")[0]
        self.assertEqual(ingress["spec"]["ingressClassName"], "cce")
        self.assertEqual(ingress["spec"]["rules"][0]["host"], "nexus.youdoogo.com")
        path_entries = ingress["spec"]["rules"][0]["http"]["paths"]
        paths = [entry["path"] for entry in path_entries]
        self.assertEqual(paths, ["/scoringsys"])
        self.assertEqual(path_entries[0]["pathType"], "Prefix")
        self.assertEqual(path_entries[0]["backend"]["service"]["name"], "scoringsys")
        self.assertEqual(path_entries[0]["backend"]["service"]["port"], {"number": 3000})
        self.assertNotIn("name", path_entries[0]["backend"]["service"]["port"])
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
        self.assertIn("backend_port=", DEPLOY_SCRIPT)
        self.assertIn("backend.service.port.number", DEPLOY_SCRIPT)
        self.assertIn("service_target_port=", DEPLOY_SCRIPT)
        self.assertIn("annotate service scoringsys ingress.kubernetes.io/named-ports- --overwrite", DEPLOY_SCRIPT)
        self.assertIn("Service server dry-run failed", DEPLOY_SCRIPT)
        self.assertIn("service_ports=", DEPLOY_SCRIPT)
        self.assertIn("metadata.generation", DEPLOY_SCRIPT)
        self.assertIn("Ingress generation is not a positive integer", DEPLOY_SCRIPT)

        workload_apply = DEPLOY_SCRIPT.index('apply -f "$workload"')
        service_annotation_delete = DEPLOY_SCRIPT.index(
            "annotate service scoringsys ingress.kubernetes.io/named-ports- --overwrite"
        )
        service_server_dry_run = DEPLOY_SCRIPT.index('apply --dry-run=server -f "$workload"', workload_apply + 1)
        service_readback = DEPLOY_SCRIPT.index("service_ports=", service_server_dry_run)
        ingress_dry_run = DEPLOY_SCRIPT.index('apply --dry-run=server -f "$ingress"')
        endpoints_ready = DEPLOY_SCRIPT.index('[[ -n "${addresses:-}" ]] || die "Service has no ready endpoints"')
        ingress_apply = DEPLOY_SCRIPT.index('apply -f "$ingress"')
        child_contract = DEPLOY_SCRIPT.index("child_master=")
        trigger_check = DEPLOY_SCRIPT.index("applied_trigger=")
        master_annotate = DEPLOY_SCRIPT.index('annotate ingress "$master_name"')
        master_trigger_check = DEPLOY_SCRIPT.index("master_applied_trigger=")
        propagation = DEPLOY_SCRIPT.index('sleep "$RECONCILE_PROPAGATION_SECONDS"')
        smoke = DEPLOY_SCRIPT.index("smoke-scoringsys.sh")
        self.assertLess(workload_apply, service_annotation_delete)
        self.assertLess(service_annotation_delete, service_server_dry_run)
        self.assertLess(service_server_dry_run, service_readback)
        self.assertLess(service_readback, ingress_dry_run)
        self.assertLess(endpoints_ready, ingress_dry_run)
        self.assertLess(ingress_dry_run, ingress_apply)
        self.assertLess(ingress_apply, child_contract)
        self.assertLess(child_contract, trigger_check)
        self.assertLess(trigger_check, master_annotate)
        self.assertLess(master_annotate, master_trigger_check)
        self.assertLess(master_trigger_check, propagation)
        self.assertLess(propagation, smoke)

    def test_deploy_reconciles_master_by_annotation_only(self) -> None:
        self.assertIn(
            'annotate ingress "$master_name" "reconcile-trigger=$master_trigger" --overwrite',
            DEPLOY_SCRIPT,
        )
        self.assertIn('kubectl -n "$master_namespace" annotate ingress "$master_name"', DEPLOY_SCRIPT)
        self.assertNotIn("annotate ingress nexus-studio", DEPLOY_SCRIPT)
        self.assertIn('master_trigger="${CI_PIPELINE_ID}-${CI_JOB_ID}"', DEPLOY_SCRIPT)
        self.assertIn("master_trigger=${master_trigger:-$applied_trigger}", DEPLOY_SCRIPT)
        self.assertIn("master Ingress reconcile annotation failed", DEPLOY_SCRIPT)
        self.assertIn("master Ingress reconcile-trigger was not updated", DEPLOY_SCRIPT)
        self.assertNotIn("patch ingress", DEPLOY_SCRIPT)
        self.assertNotIn("apply -f \"$master", DEPLOY_SCRIPT)
        self.assertNotIn("delete ingress \"$master", DEPLOY_SCRIPT)
        self.assertNotIn("tls-certificate-ids", DEPLOY_SCRIPT.split("annotate ingress", 1)[1])

    def test_deploy_validates_frozen_master_reference_before_cluster_mutation(self) -> None:
        self.assertIn("CCE_LISTENER_MASTER_INGRESS must be namespace/name", DEPLOY_SCRIPT)
        self.assertIn("master Ingress namespace is not DNS-compatible", DEPLOY_SCRIPT)
        self.assertIn("master Ingress name is not DNS-compatible", DEPLOY_SCRIPT)
        self.assertIn('[[ "$master_namespace" == "$NAMESPACE" ]]', DEPLOY_SCRIPT)

        # Execute only the preflight path with a command stub. Unsafe references
        # must fail before a rendered manifest or kubectl mutation is inspected.
        for reference, expected in (
            ("nexus-prod/nexus-studio/extra", "namespace/name"),
            ("nexus-prod/nexus-studio;touch", "master Ingress name"),
            ("other-prod/nexus-studio", "must match KUBE_NAMESPACE"),
        ):
            with self.subTest(reference=reference), tempfile.TemporaryDirectory() as directory:
                command_dir = Path(directory)
                stub_log = command_dir / "stub-invocations.log"
                stub_script = '#!/bin/sh\nprintf \'%s\\n\' "${0##*/}" >>"$COMMAND_STUB_LOG"\nexit 0\n'
                for command_name in ("kubectl", "base64", "curl"):
                    command_stub = command_dir / command_name
                    command_stub.write_text(stub_script, encoding="utf-8")
                    command_stub.chmod(0o755)
                env = os.environ.copy()
                env.update(
                    {
                        "PATH": f"{command_dir}:{env.get('PATH', '')}",
                        "COMMAND_STUB_LOG": str(stub_log),
                        "KUBECONFIG_CCE_B64": "eA==",
                        "KUBE_IMAGE_PULL_SECRET": "swr-pull",
                        "CCE_LISTENER_MASTER_INGRESS": reference,
                        "RENDERED_DIR": str(command_dir / "rendered"),
                    }
                )
                result = subprocess.run(["bash", str(ROOT / "scripts/ci/deploy-cce.sh")], env=env, text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                invoked_commands = stub_log.read_text(encoding="utf-8").splitlines() if stub_log.exists() else []
                self.assertNotIn("kubectl", invoked_commands)

    def test_deploy_gates_forbidden_shared_listener_annotations(self) -> None:
        for forbidden in FATAL_LIVE_INGRESS_ANNOTATIONS:
            self.assertIn(forbidden, DEPLOY_SCRIPT)
        self.assertIn("Ingress must not declare $forbidden on the shared listener", DEPLOY_SCRIPT)
        self.assertIn("ingress.kubernetes.io/named-ports", DEPLOY_SCRIPT)
        self.assertIn("ignoring it in favor of the numeric backend contract", DEPLOY_SCRIPT)
        self.assertIn("rolled out image does not match IMAGE_REFERENCE", DEPLOY_SCRIPT)

    def test_deploy_reads_annotations_with_go_template_through_master_readback(self) -> None:
        # kubectl 1.30 treats dots and slashes in a jsonpath map lookup as path
        # syntax. The stub only returns annotation values for go-template reads,
        # so a jsonpath regression fails before the master annotation step.
        self.assertNotIn("metadata.annotations['kubernetes.io/", DEPLOY_SCRIPT)
        self.assertNotIn("metadata.annotations[", DEPLOY_SCRIPT)
        self.assertIn("get_ingress_annotation()", DEPLOY_SCRIPT)
        with tempfile.TemporaryDirectory() as directory:
            command_dir = Path(directory)
            rendered_dir = command_dir / "rendered"
            rendered_dir.mkdir()
            (rendered_dir / "deployment.yaml").write_text("kind: Deployment\n", encoding="utf-8")
            (rendered_dir / "ingress.yaml").write_text("kind: Ingress\n", encoding="utf-8")
            (rendered_dir / "networkpolicy.yaml").write_text("kind: NetworkPolicy\n", encoding="utf-8")
            stub_log = command_dir / "kubectl-invocations.log"
            kubectl_stub = r'''#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$COMMAND_STUB_LOG"
format=
previous=
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then
    format=$arg
    previous=
  elif [ "$arg" = "-o" ]; then
    previous=-o
  fi
done
case "$format" in
  go-template=*)
    case "$format" in
      *'if eq .name "http"'*'targetPort'*) printf '%s' "${CCE_STUB_TARGET_PORT:-3000}" ;;
      *'range .spec.ports'*) printf '%s' "${CCE_STUB_SERVICE_STATE:-http|3000|3000}" ;;
      *'kubernetes.io/elb.class'*) printf '%s' "${CCE_ELB_CLASS:-performance}" ;;
      *'kubernetes.io/elb.id'*) printf '%s' "${CCE_ELB_ID:-abab7533-a1c6-4138-a4bc-59d53e3446e2}" ;;
      *'kubernetes.io/elb.port'*) printf '%s' "${CCE_ELB_PORT:-80}" ;;
      *'kubernetes.io/elb.listener-master-ingress'*) printf '%s' "${CCE_LISTENER_MASTER_INGRESS:-nexus-prod/nexus-studio}" ;;
      *'ingress.kubernetes.io/named-ports'*)
        case "$*" in
          *'get service scoringsys'*)
            service_annotation_reads_file=${CCE_STUB_SERVICE_ANNOTATION_READS_FILE:?}
            service_annotation_reads=0
            if [ -f "$service_annotation_reads_file" ]; then
              service_annotation_reads=$(cat "$service_annotation_reads_file")
            fi
            service_annotation_reads=$((service_annotation_reads + 1))
            printf '%s' "$service_annotation_reads" >"$service_annotation_reads_file"
            if [ "$service_annotation_reads" -eq 1 ]; then
              printf '%s' "${CCE_STUB_SERVICE_NAMED_PORTS_BEFORE:-}"
            else
              printf '%s' "${CCE_STUB_SERVICE_NAMED_PORTS_AFTER:-}"
            fi
            ;;
          *) printf '%s' "${CCE_STUB_NAMED_PORTS:-}" ;;
        esac
        ;;
      *'reconcile-trigger'*)
        case "$*" in
          *'get ingress nexus-studio'*) printf '%s' "2104-14012" ;;
          *) printf '%s' "test-trigger" ;;
        esac
        ;;
    esac
    exit 0
    ;;
  *'metadata.annotations['*)
    printf '%s\n' "annotation jsonpath was used" >&2
    exit 31
    ;;
esac
case "$*" in
  *' apply -f '*ingress.yaml)
    printf '%s' applied >"$CCE_STUB_STATE_FILE"
    ;;
esac
case "$*" in
  *' annotate service scoringsys ingress.kubernetes.io/named-ports- '*--overwrite*)
    if [ "${CCE_STUB_SERVICE_ANNOTATE_DELETE_STATUS:-0}" != 0 ]; then
      printf '%s\n' 'error: annotation "ingress.kubernetes.io/named-ports" not found' >&2
      exit "${CCE_STUB_SERVICE_ANNOTATE_DELETE_STATUS}"
    fi
    ;;
esac
case "$format" in
  'jsonpath={.type}') printf '%s' kubernetes.io/dockerconfigjson ;;
  *'subsets'*'addresses'*'ip}') printf '%s' 10.0.0.1 ;;
  *'metadata.generation'*'backend.service.port.number'*'backend.service.port.name'*)
    if [ "${CCE_STUB_OLD_INGRESS_EXISTS:-0}" = 1 ]; then
      printf '%s' "${CCE_STUB_OLD_INGRESS_STATE:-2||http}"
    else
      exit 1
    fi
    ;;
  *'backend.service.port.number'*'backend.service.port.name'*) printf '%s' "${CCE_STUB_NEW_BACKEND_STATE:-3000|}" ;;
  *'spec.rules'*'host}') printf '%s' nexus.youdoogo.com ;;
  *'http.paths'*'path}'*) printf '/scoringsys\n' ;;
  *'metadata.generation}') printf '%s' "${CCE_STUB_NEW_GENERATION:-3}" ;;
  *'spec.template.spec.containers'*'image}') printf '%s' registry.example/scoringsys:test ;;
esac
exit 0
'''
            kubectl_path = command_dir / "kubectl"
            kubectl_path.write_text(kubectl_stub, encoding="utf-8")
            kubectl_path.chmod(0o755)
            base64_path = command_dir / "base64"
            base64_path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            base64_path.chmod(0o755)
            curl_stub = r'''#!/bin/sh
set -eu
headers=
body=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dump-header|--output)
      target=$1
      value=$2
      [ "$target" = "--dump-header" ] && headers=$value || body=$value
      shift 2
      ;;
    --write-out) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */scoringsys/)
    printf 'HTTP/1.1 308 Permanent Redirect\nlocation: /scoringsys\n\n' >"$headers"
    : >"$body"
    printf 308
    ;;
  */_next/static/*)
    printf 'HTTP/1.1 200 OK\ncontent-type: application/javascript\n\n' >"$headers"
    printf asset >"$body"
    printf 200
    ;;
  */scoringsys/api/health/db)
    printf 'HTTP/1.1 200 OK\ncontent-type: application/json\n\n' >"$headers"
    printf '{"ok":true,"pool":{}}' >"$body"
    printf 200
    ;;
  */scoringsys/api/summary)
    printf 'HTTP/1.1 200 OK\ncontent-type: application/json\n\n' >"$headers"
    printf '{}' >"$body"
    printf 200
    ;;
  */scoringsys)
    printf 'HTTP/1.1 200 OK\ncontent-type: text/html\n\n' >"$headers"
    printf 'marker /scoringsys/_next/static/app.js' >"$body"
    printf 200
    ;;
  *)
    printf 'HTTP/1.1 404 Not Found\n\n' >"$headers"
    : >"$body"
    printf 404
    ;;
esac
'''
            curl_path = command_dir / "curl"
            curl_path.write_text(curl_stub, encoding="utf-8")
            curl_path.chmod(0o755)
            base_env = os.environ.copy()
            base_env.update(
                {
                    "PATH": f"{command_dir}:{base_env.get('PATH', '')}",
                    "COMMAND_STUB_LOG": str(stub_log),
                    "CCE_STUB_STATE_FILE": str(command_dir / "ingress-applied"),
                    "CCE_STUB_SERVICE_ANNOTATION_READS_FILE": str(command_dir / "service-annotation-reads"),
                    "CCE_STUB_OLD_INGRESS_EXISTS": "1",
                    "CCE_STUB_SERVICE_STATE": "http|3000|3000",
                    "KUBECONFIG_CCE_B64": "eA==",
                    "KUBE_IMAGE_PULL_SECRET": "swr-pull",
                    "RUNTIME_SECRET_NAME": "scoringsys-runtime",
                    "RENDERED_DIR": str(rendered_dir),
                    "IMAGE_REFERENCE": "registry.example/scoringsys:test",
                    "RECONCILE_TRIGGER": "",
                    "CI_PIPELINE_ID": "2104",
                    "CI_JOB_ID": "14012",
                    "SMOKE_HTML_MARKER": "marker",
                    "SMOKE_ATTEMPTS": "1",
                    "SMOKE_DELAY_SECONDS": "0",
                    "RECONCILE_PROPAGATION_SECONDS": "0",
                }
            )
            scenarios = (
                ("2||http", "3000|", "3", "http|3000|3000", "", "", "", "", 0, ""),
                ("3|3000|", "3000|", "3", "http|3000|3000", "", '{"http":"3000"}', "", "", 0, ""),
                ("3|3000|", "3000|", "3", "http|3000|3000", '{"http":"3000"}', '{"http":"3000"}', '{"http":"3000"}', "", 1, "rewritten by"),
                ("3|3000|", "3000|", "3", "http|3000|3000", "", "", "", "1", 0, ""),
                ("2||http", "3000|", "2", "http|3000|3000", "", "", "", "", 1, "generation did not increase"),
                ("3|3000|", "|http", "4", "http|3000|3000", '{"http":"3000"}', "", "", "", 1, "must be exactly number=3000"),
                ("3|3000|", "3000|", "3", "http|3000|http", "", "", "", "", 1, "targetPort=3000"),
            )
            for (
                old_state,
                backend_state,
                generation,
                service_state,
                named_ports,
                service_named_ports_before,
                service_named_ports_after,
                service_annotate_delete_status,
                expected_returncode,
                expected_error,
            ) in scenarios:
                with self.subTest(old_state=old_state, backend_state=backend_state, generation=generation, service_state=service_state):
                    state_file = command_dir / "ingress-applied"
                    state_file.unlink(missing_ok=True)
                    (command_dir / "service-annotation-reads").unlink(missing_ok=True)
                    stub_log.write_text("", encoding="utf-8")
                    env = base_env | {
                        "CCE_STUB_OLD_INGRESS_STATE": old_state,
                        "CCE_STUB_NEW_BACKEND_STATE": backend_state,
                        "CCE_STUB_NEW_GENERATION": generation,
                        "CCE_STUB_SERVICE_STATE": service_state,
                        "CCE_STUB_NAMED_PORTS": named_ports,
                        "CCE_STUB_SERVICE_NAMED_PORTS_BEFORE": service_named_ports_before,
                        "CCE_STUB_SERVICE_NAMED_PORTS_AFTER": service_named_ports_after,
                        "CCE_STUB_SERVICE_ANNOTATE_DELETE_STATUS": service_annotate_delete_status,
                    }
                    result = subprocess.run(
                        ["bash", str(ROOT / "scripts/ci/deploy-cce.sh")],
                        env=env,
                        text=True,
                        capture_output=True,
                    )
                    self.assertEqual(result.returncode, expected_returncode, result.stderr)
                    if expected_error:
                        self.assertIn(expected_error, result.stderr)
                        if named_ports:
                            self.assertIn("must not rely on it", result.stderr)
                        if service_named_ports_after:
                            self.assertIn("strict smoke must fail", result.stderr)
                        continue
                    if named_ports:
                        self.assertIn("ignoring it in favor of the numeric backend contract", result.stderr)
                    invocations = stub_log.read_text(encoding="utf-8").splitlines()
                    annotation_reads = [
                        line
                        for line in invocations
                        if "get ingress" in line and "go-template={{ with index .metadata.annotations" in line
                    ]
                    self.assertEqual(len(annotation_reads), 10)
                    self.assertTrue(all("go-template=" in line for line in annotation_reads))
                    for key in (
                        "kubernetes.io/elb.class",
                        "kubernetes.io/elb.id",
                        "kubernetes.io/elb.port",
                        "kubernetes.io/elb.listener-master-ingress",
                        "kubernetes.io/elb.listen-ports",
                        "kubernetes.io/elb.tls-certificate-ids",
                        "kubernetes.io/ingress.class",
                        "ingress.kubernetes.io/named-ports",
                        "reconcile-trigger",
                    ):
                        self.assertIn(key, "\n".join(annotation_reads))
                    self.assertIn(
                        "annotate ingress nexus-studio reconcile-trigger=2104-14012 --overwrite",
                        "\n".join(invocations),
                    )
                    self.assertIn(
                        "annotate service scoringsys ingress.kubernetes.io/named-ports- --overwrite",
                        "\n".join(invocations),
                    )
                    service_annotation_reads = [
                        line
                        for line in invocations
                        if "get service scoringsys" in line
                        and "ingress.kubernetes.io/named-ports" in line
                    ]
                    self.assertEqual(len(service_annotation_reads), 3 if service_annotate_delete_status else 2)

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
            env["RUNTIME_SECRET_NAME"] = "scoringsys-runtime"
            env["POSTGRES_SERVICE_NAME"] = "postgres"
            env["POSTGRES_POD_LABEL_KEY"] = "app"
            env["POSTGRES_POD_LABEL_VALUE"] = "postgres"
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

    def test_renderer_uses_a_pipeline_job_trigger_when_no_override_is_given(self) -> None:
        rendered = self.render(RECONCILE_TRIGGER=None, CI_PIPELINE_ID="2102", CI_JOB_ID="13998")
        annotations = rendered["ingress"][0]["metadata"]["annotations"]
        self.assertEqual(annotations["reconcile-trigger"], "2102-13998")
        self.assertRegex(annotations["reconcile-trigger"], r"^[A-Za-z0-9._-]{1,63}$")

    def test_renderer_never_emits_an_empty_trigger_without_ci_identifiers(self) -> None:
        rendered = self.render(RECONCILE_TRIGGER="", CI_PIPELINE_ID="", CI_JOB_ID="", CI_COMMIT_SHA="")
        self.assertEqual(rendered["ingress"][0]["metadata"]["annotations"]["reconcile-trigger"], "local")

    def test_renderer_rejects_sub_ingress_claiming_the_shared_listener(self) -> None:
        injections = {
            "kubernetes.io/elb.listen-ports": '\'[{"HTTP":80},{"HTTPS":443}]\'',
            "kubernetes.io/elb.tls-certificate-ids": "56de20421757445ea53f5af51ecb4e10",
            "kubernetes.io/ingress.class": "cce",
            "ingress.kubernetes.io/named-ports": '\'{"http":"3000"}\'',
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
            template_dir = self.mutated_templates(directory, lambda text: text)
            # A probe on the slashed form only ever sees the Next.js 308, which
            # kubelet accepts as success -- Ready without a rendered page.
            (template_dir / "deployment.yaml.tmpl").write_text(
                DEPLOYMENT_TEMPLATE.replace("path: /scoringsys", "path: /scoringsys/"), encoding="utf-8"
            )
            stderr = self.render_expecting_failure(template_dir)
            self.assertIn("does not match PUBLIC_PREFIX", stderr)

        with tempfile.TemporaryDirectory() as directory:
            template_dir = self.mutated_templates(
                directory,
                lambda text: text.replace("number: 3000", "name: http"),
            )
            stderr = self.render_expecting_failure(template_dir)
            self.assertIn("backend service port must be exactly {number: 3000}", stderr)

        with tempfile.TemporaryDirectory() as directory:
            template_dir = self.mutated_templates(directory, lambda text: text)
            (template_dir / "deployment.yaml.tmpl").write_text(
                DEPLOYMENT_TEMPLATE.replace("targetPort: 3000", "targetPort: http"), encoding="utf-8"
            )
            stderr = self.render_expecting_failure(template_dir)
            self.assertIn("Service port must be exactly name=http, port=3000, targetPort=3000", stderr)

    def test_negative_mutations_fail_contract(self) -> None:
        paths = [entry["path"] for entry in parse_yaml_documents(ROOT / "ops/cce/ingress.yaml.tmpl")[0]["spec"]["rules"][0]["http"]["paths"]]
        self.assertEqual(paths, ["/scoringsys"])
        mutated_paths = paths + ["/"]
        self.assertNotEqual(mutated_paths, ["/scoringsys"])
        self.assertNotIn("--provenance=false", CI.replace("--provenance=false", ""))
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["deploy-cce"]["retry"] = 1
        self.assertNotEqual(mutated_pipeline["deploy-cce"]["retry"], 0)
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["scan-image"]["image"].pop("entrypoint")
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
        # A shared builder name buys no cache on this runner and is forbidden.
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["build-image"]["variables"]["BUILDX_BUILDER"] = "scoringsys-ci"
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        # The per-job builder must be cleaned up again.
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["build-image"]["after_script"] = ["true"]
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        # The registry cache must never be written to the immutable commit tag.
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["build-image"]["variables"]["BUILD_CACHE_TAG"] = "${CI_COMMIT_SHA}"
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        # mode=max must stay: a min-mode cache drops the intermediate layers.
        mutated_pipeline = yaml.safe_load(CI.replace("},mode=max,", "},mode=min,", 1))
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        # Dropping either half of the registry cache breaks the contract.
        for removed in ('--cache-from "type=registry,ref=${BUILD_CACHE_REF}" \\\n', "--cache-to "):
            mutated_pipeline = yaml.safe_load(CI.replace(removed, "", 1))
            with self.assertRaises(AssertionError):
                self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        # Re-adding --pull, unbounding the retry, or swallowing the final
        # failure must each fail the contract.
        mutated_pipeline = yaml.safe_load(CI.replace("--push \\\n", "--push --pull \\\n", 1))
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        mutated_pipeline = yaml.safe_load(CI.replace('while [ "$attempt" -le 2 ]', "while true", 1))
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["build-image"]["script"] = [
            command.replace('docker buildx build failed after 2 attempts" >&2', 'ok"').replace(
                "  exit 1\n", "  true\n"
            )
            for command in mutated_pipeline["build-image"]["script"]
        ]
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        mutated_pipeline = yaml.safe_load(
            CI.replace(' --build-arg "APK_UPGRADE_DATE=$(date -u +%Y-%m-%d)"', "", 1)
        )
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["scan-image"]["allow_failure"] = True
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(
                yaml.safe_load(CI),
                DOCKERFILE.replace("apk upgrade --no-cache libcrypto3 libssl3", "true"),
            )
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(
                yaml.safe_load(CI), DOCKERFILE.replace("npm ci --prefer-offline", "npm install")
            )
        mutated_pipeline = yaml.safe_load(CI)
        mutated_pipeline["verify-app"]["script"] = ["npm ci --prefer-offline", "npm run build"]
        with self.assertRaises(AssertionError):
            self.assert_build_cache_contract(mutated_pipeline, DOCKERFILE)
        self.assertNotIn("kind: Secret", DEPLOYMENT_TEMPLATE)
        self.assertNotIn("kind: ConfigMap", INGRESS_TEMPLATE)

    def test_trivy_db_source_and_cache_contract_is_bounded(self) -> None:
        pipeline = yaml.safe_load(CI)
        scan = pipeline["scan-image"]
        script = "\n".join(scan["script"])
        self.assertIn("public.ecr.aws/aquasecurity/trivy-db:2", script)
        self.assertNotIn("TRIVY_DB_REPOSITORY_PRIMARY", script)
        self.assertNotIn("TRIVY_DB_REPOSITORY_FALLBACK", script)
        self.assertNotIn("TRIVY_DB_REPOSITORY_ALLOWED_HOSTS", script)
        self.assertNotIn("allowlist", script.lower())
        self.assertEqual(script.count("--download-db-only"), 1)
        self.assertEqual(script.count('--timeout "$TRIVY_DB_DOWNLOAD_TIMEOUT"'), 1)
        self.assertEqual(script.count('while [ "$attempt" -le 2 ]'), 1)
        self.assertEqual(script.count("sleep 2"), 1)
        self.assertIn('--timeout "$TRIVY_DB_DOWNLOAD_TIMEOUT"', script)
        self.assertIn('--cache-dir "$TRIVY_CACHE_DIR"', script)
        self.assertEqual(scan["cache"]["paths"], [".trivycache/"])
        self.assertTrue(scan["cache"]["unprotect"])

    def test_trivy_db_runtime_attempts_the_same_source_twice(self) -> None:
        suffix = r'''
attempts=0
mkdir -p "$TRIVY_CACHE_DIR/db"
printf valid > "$TRIVY_CACHE_DIR/db/trivy.db"
trivy() {
  attempts=$((attempts + 1))
  [ "$TRIVY_DB_REPOSITORY" = "public.ecr.aws/aquasecurity/trivy-db:2" ] || return 88
  case "$*" in *--download-db-only*) ;; *) return 89 ;; esac
  case "$*" in *--cache-dir*) ;; *) return 90 ;; esac
  case "$*" in *--timeout\ 5m*) ;; *) return 91 ;; esac
  printf partial > "$TRIVY_CACHE_DIR/db/trivy.db.tmp"
  return 1
}
sleep() { :; }
download_trivy_db
[ -f "$TRIVY_CACHE_DIR/db/trivy.db" ] || exit 92
[ ! -e "$TRIVY_CACHE_DIR/db/trivy.db.tmp" ] || exit 93
printf 'bounded-attempts=%s\n' "$attempts"
'''
        result = self.run_trivy_db_setup(suffix=suffix)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("bounded-attempts=2", result.stdout)

    def test_scan_failure_blocks_deploy_and_keeps_the_gate(self) -> None:
        pipeline = yaml.safe_load(CI)
        scan = pipeline["scan-image"]
        script = "\n".join(scan["script"])
        self.assertIn("exit 1", script)
        self.assertIn("--severity HIGH,CRITICAL", script)
        self.assertIn("--exit-code 1", script)
        self.assertNotIn("allow_failure", scan)
        self.assertIn({"job": "scan-image"}, pipeline["deploy-cce"]["needs"])

    def test_renderer_emits_workload_ingress_and_network_policy_as_parseable_documents(self) -> None:
        rendered = self.render(
            POSTGRES_SERVICE_NAME="postgres",
            POSTGRES_POD_LABEL_KEY="app.kubernetes.io/name",
            POSTGRES_POD_LABEL_VALUE="postgres",
        )
        self.assertEqual({doc["kind"] for doc in rendered["deployment"]}, {"Deployment", "Service"})
        self.assertEqual({doc["kind"] for doc in rendered["ingress"]}, {"Ingress"})
        self.assertEqual({doc["kind"] for doc in rendered["networkpolicy"]}, {"NetworkPolicy"})
        self.assertEqual(set(rendered), {"deployment", "ingress", "networkpolicy"})
        for stem in ("job-migrate", "job-import"):
            self.assertFalse((ROOT / "ops/cce" / f"{stem}.yaml.tmpl").exists())

    def test_web_mounts_only_runtime_secret(self) -> None:
        rendered = self.render(
            RUNTIME_SECRET_NAME="runtime-custom",
            RUNTIME_CONFIGMAP_NAME=None,
            POSTGRES_SERVICE_NAME="postgres",
            POSTGRES_POD_LABEL_KEY="app.kubernetes.io/name",
            POSTGRES_POD_LABEL_VALUE="postgres",
        )
        deployment = rendered["deployment"][0]
        env_from = deployment["spec"]["template"]["spec"]["containers"][0].get("envFrom", [])
        self.assertEqual(env_from, [{"secretRef": {"name": "runtime-custom"}}])
        encoded = json.dumps(deployment)
        self.assertNotIn("scoringsys-migrator", encoded)
        self.assertNotIn("SUPABASE", encoded.upper())
        self.assertNotIn("migrat", encoded.lower())

    def test_runtime_secret_is_required_and_not_created(self) -> None:
        with self.assertRaises(AssertionError):
            self.render(
                RUNTIME_SECRET_NAME=None,
                POSTGRES_SERVICE_NAME="postgres",
                POSTGRES_POD_LABEL_KEY="app.kubernetes.io/name",
                POSTGRES_POD_LABEL_VALUE="postgres",
            )
        for stem in CCE_TEMPLATE_STEMS:
            template = (ROOT / "ops/cce" / f"{stem}.yaml.tmpl").read_text(encoding="utf-8")
            self.assertNotIn("kind: Secret", template)
            self.assertNotIn("kind: ConfigMap", template)

    def test_network_policy_uses_rendered_postgres_selector_and_dns_only(self) -> None:
        rendered = self.render(
            POSTGRES_SERVICE_NAME="postgres-primary",
            POSTGRES_POD_LABEL_KEY="database",
            POSTGRES_POD_LABEL_VALUE="postgres-16",
        )
        policy = rendered["networkpolicy"][0]
        self.assertEqual(policy["spec"]["podSelector"], {"matchLabels": {"app.kubernetes.io/name": "scoringsys"}})
        self.assertEqual(policy["metadata"]["annotations"]["scoringsys.io/postgres-service"], "postgres-primary")
        egress = policy["spec"]["egress"]
        postgres_rules = [rule for rule in egress if any(port.get("port") == 5432 for port in rule.get("ports", []))]
        self.assertEqual(len(postgres_rules), 1)
        self.assertEqual(postgres_rules[0]["to"], [{"podSelector": {"matchLabels": {"database": "postgres-16"}}}])
        dns_ports = [port for rule in egress for port in rule.get("ports", []) if port.get("port") == 53]
        self.assertEqual({(port["protocol"], port["port"]) for port in dns_ports}, {("UDP", 53), ("TCP", 53)})
        self.assertNotIn("NodePort", json.dumps(policy))
        self.assertNotIn("LoadBalancer", json.dumps(policy))

    def test_network_policy_rejects_missing_or_invalid_selector_inputs(self) -> None:
        for overrides, expected in (
            ({"POSTGRES_POD_LABEL_KEY": None}, "POSTGRES_POD_LABEL_KEY"),
            ({"POSTGRES_POD_LABEL_VALUE": None}, "POSTGRES_POD_LABEL_VALUE"),
            ({"POSTGRES_SERVICE_NAME": "bad/name"}, "POSTGRES_SERVICE_NAME"),
        ):
            with self.subTest(overrides=overrides):
                with self.assertRaises(AssertionError) as failure:
                    values = {
                        "POSTGRES_SERVICE_NAME": "postgres",
                        "POSTGRES_POD_LABEL_KEY": "app",
                        "POSTGRES_POD_LABEL_VALUE": "postgres",
                    }
                    values.update(overrides)
                    self.render(**values)
                self.assertIn(expected, str(failure.exception))
        with self.assertRaises(AssertionError) as failure:
            self.render(DB_POOL_MAX="41")
        self.assertIn("no greater than 40", str(failure.exception))

    def test_negative_manifest_mutations_are_rejected_by_renderer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            template_dir = self.mutated_templates(directory, lambda text: text)
            policy_path = template_dir / "networkpolicy.yaml.tmpl"
            policy_path.write_text(policy_path.read_text(encoding="utf-8").replace("port: 53", "port: 443", 1), encoding="utf-8")
            stderr = self.render_expecting_failure(template_dir)
            self.assertIn("NetworkPolicy must allow only", stderr)

        with tempfile.TemporaryDirectory() as directory:
            template_dir = self.mutated_templates(directory, lambda text: text)
            deployment_path = template_dir / "deployment.yaml.tmpl"
            deployment_path.write_text(
                deployment_path.read_text(encoding="utf-8").replace(
                    "{{RUNTIME_ENV_BLOCK}}",
                    "{{RUNTIME_ENV_BLOCK}}\n          envFrom:\n            - secretRef:\n                name: scoringsys-migrator",
                ),
                encoding="utf-8",
            )
            stderr = self.render_expecting_failure(template_dir)
            self.assertIn("only RUNTIME_SECRET_NAME", stderr)

    def test_ci_has_no_database_jobs_or_mutations(self) -> None:
        pipeline = yaml.safe_load(CI)
        self.assertEqual(pipeline["stages"], ["verify", "build", "scan", "deploy", "notify"])
        for forbidden in (
            "db-gates",
            "migrate-db",
            "import-db",
            "PRODUCTION_DB_MUTATION_APPROVED",
            "MIGRATOR_SECRET_NAME",
            "SNAPSHOT_FILE",
            "MANIFEST_FILE",
            "scripts/db/",
            "scoringsys-db-mutation",
        ):
            self.assertNotIn(forbidden, CI)
        deploy = pipeline["deploy-cce"]
        self.assertEqual(deploy["stage"], "deploy")
        needed = {item["job"] for item in deploy["needs"]}
        self.assertEqual(needed, {"render-cce", "build-image", "scan-image"})
        self.assertEqual(deploy["rules"], [{"if": "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH"}])
        self.assertNotIn("when", deploy)

    def test_deploy_script_applies_network_policy_but_never_runs_db_mutation(self) -> None:
        self.assertIn("networkpolicy.yaml", DEPLOY_SCRIPT)
        self.assertNotIn("scripts/db/migrate", DEPLOY_SCRIPT)
        self.assertNotIn("scripts/db/import", DEPLOY_SCRIPT)
        self.assertNotIn("kubectl apply -f \"$migrate", DEPLOY_SCRIPT)
        self.assertNotIn("kubectl apply -f \"$import", DEPLOY_SCRIPT)

    def test_smoke_checks_db_health_and_summary_without_making_db_probe_liveness(self) -> None:
        self.assertIn("/api/health/db", SMOKE_SCRIPT)
        self.assertIn("/api/summary", SMOKE_SCRIPT)
        self.assertIn("curl", SMOKE_SCRIPT)
        self.assertNotIn("health/db", DEPLOYMENT_TEMPLATE)
        self.assertNotIn("health/db", DEPLOY_SCRIPT.split("smoke-scoringsys.sh", 1)[0])


if __name__ == "__main__":
    unittest.main()
