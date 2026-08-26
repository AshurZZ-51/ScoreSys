# ScoreSys PostgreSQL Direct T10 Summary

status: complete

## RED

- Added positive and negative delivery-contract tests before implementation.
- Initial run failed because the renderer emitted only Deployment/Service and Ingress, CI had no `db-gates`, and smoke had no database checks.

## GREEN

- Added `ops/cce/job-migrate.yaml.tmpl`, `ops/cce/job-import.yaml.tmpl`, and `ops/cce/networkpolicy.yaml.tmpl`.
- Renderer now emits and parses all five artifacts, rejects Secret/ConfigMap resources, requires the runtime Secret and explicit PostgreSQL service/label inputs, validates the pool budget, web Secret isolation, Job security, and exact egress rules.
- Web probes remain on `/scoringsys`; no database health probe was added.
- CI now orders `verify -> build -> scan -> db-gates -> deploy`; migration/import gates are manual, non-retryable, non-interruptible, approval-gated, and fail closed. Import uses a one-shot `kubectl run --rm -i` stdin stream.
- Deploy applies the rendered NetworkPolicy and requires the existing runtime Secret; it does not run migration/import scripts.
- Smoke retains page, strict static asset, and slash-308 checks and adds a bounded DB-health check; authenticated summary JSON is checked when `SMOKE_SUMMARY_MEETING_ID` is supplied.
- Optional GitLab CI Lint API validation was added without printing the job token.

## Verification

- `python3 -m unittest tests/test_cce_delivery_contract.py`: 35 passed.
- `npm ci --prefer-offline --no-audit --no-fund`: passed.
- `npm test`: 22 passed.
- `npm run build`: passed.
- Render fixture with explicit runtime/migrator Secret and PostgreSQL selector inputs: all five YAML files parsed (`Deployment/Service`, `Ingress`, `Job`, `Job`, `NetworkPolicy`).
- `bash -n scripts/ci/deploy-cce.sh scripts/ci/smoke-scoringsys.sh`: passed.
- `git diff --check`: passed.
- GitLab CI Lint API was not called locally because no CI API/token context was available; the pipeline job calls it only when those variables exist.

## Risks

- Runtime and migrator Secret values remain intentionally out-of-band; CI only checks Secret existence and never prints or reads values.
- `POSTGRES_POD_LABEL_KEY`/`POSTGRES_POD_LABEL_VALUE` must match the existing PostgreSQL Pods; rendering fails when they are absent or unsafe.
- The summary endpoint is authenticated and may require an operator-provided meeting context in production; `SUMMARY_PATH` can be configured for the smoke environment.
- No cluster server dry-run or apply was executed from this task.
- The requested sibling path `/home/zoey/agent-work/scoringsys-pg-campaign/t10-summary.md` is outside the sandbox writable root; an escalation request was rejected by the unavailable approval service. The same summary is retained at `t10/t10-summary.md`.
