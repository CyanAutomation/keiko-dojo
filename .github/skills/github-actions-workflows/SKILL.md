---
name: github-actions-workflows
description: Maintain Keiko's GitHub Actions, Dependabot automation, CI gates, deployment workflow, and workflow security controls.
tags: [keiko-dojo, github-actions, ci, supply-chain, deployment]
relatedSkills: [cloudflare-operations]
---

# GitHub Actions Workflows

Use this skill when changing files under `.github/workflows/`, Dependabot
configuration, CI requirements, or automated deployment behavior.

## Read first

- All workflow files under `.github/workflows/`, including both `.yml` and
  `.yaml` files.
- `.github/dependabot.yml` and
  `.github/workflows/dependabot-auto-merge.yaml` for dependency update policy.
- `package.json` for the package scripts invoked by automation.
- `README.md` and `docs/operations.md` for deployment and migration procedure.
- `cloudflare-operations` when a workflow changes Worker deployment, secrets,
  or database migration steps.

## Workflow rules

- Give each workflow and job only the permissions it needs. Keep workflow-level
  permissions restrictive and grant additional permissions only to the job
  that needs them.
- Pin third-party actions to full commit SHAs and retain a readable version
  comment. Disable checkout credential persistence when later steps do not
  need a write-capable checkout token.
- Keep triggers, branch filters, concurrency groups, cancellation behavior, and
  timeouts intentional. Review the trust boundary for pull request code before
  exposing secrets or write permissions.
- Keep CI and production deployment gates aligned. The deployment workflow
  should run the required dependency, test, generated-type, TypeScript, and
  migration checks before applying production migrations or deploying.
- Preserve the production dispatch branch guard, protected GitHub Environment,
  and explicit credential checks. Never place Cloudflare credentials in the
  repository or workflow source.
- Keep Dependabot update scope and cooldown policy explicit. Auto-merge must
  remain restricted to trusted Dependabot pull requests and approved update
  classes; do not broaden it to arbitrary contributors or major updates.
- Ensure workflow syntax and security analysis cover every workflow file,
  including `.yaml` as well as `.yml`.

## Verification

- Run the repository's workflow syntax and security checks through
  `.github/workflows/workflow-quality.yml`.
- Confirm the workflow receives the permissions needed by the selected action
  and still passes its branch, event, and concurrency conditions.
- For CI or deployment gate changes, compare `.github/workflows/ci.yml`,
  `.github/workflows/deploy-production.yml`, `package.json`, and the published
  operational instructions for drift.
