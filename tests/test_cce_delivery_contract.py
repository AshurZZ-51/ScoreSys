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
    "ingress.kubernetes.io/named-ports",
)
FATAL_LIVE_INGRESS_ANNOTATIONS = FORBIDDEN_SUB_INGRESS_ANNOTATIONS[:3]


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
            template_dir = Path(directory)
            (template_dir / "ingress.yaml.tmpl").write_text(INGRESS_TEMPLATE, encoding="utf-8")
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
            template_dir = Path(directory)
            (template_dir / "ingress.yaml.tmpl").write_text(INGRESS_TEMPLATE, encoding="utf-8")
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
        mutated_pipeline = CI.replace("retry: 0", "retry: 1", 1)
        self.assertNotEqual(yaml.safe_load(mutated_pipeline)["deploy-cce"]["retry"], 0)
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


if __name__ == "__main__":
    unittest.main()
