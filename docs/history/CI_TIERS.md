# CI tiers

FindBack runs different amounts of work depending on what triggered the pipeline. This
page describes what actually runs today, not an aspirational target.

## On every push to `main` and every pull request

`.github/workflows/ci.yml`:

- commit-message and version-sync conventions (full history, no dependencies);
- shared build, typecheck, lint, secret scan, dependency CVE baseline and audit;
- completion-ledger integrity gate and keyless map-provider gate;
- API tests and the full mobile test suite;
- release-infra, config, native-policy and cross-environment script tests;
- SQL behaviour suites against real PostgreSQL (migration chain, candidate readers,
  roles/capabilities, phone verification and related guards);
- the configured mobile web build. This last step runs on `main` pushes and manual
  dispatches only, so pull-request feedback stays fast.

The local AI workflows (`local-ai-native`, `local-ai-model-smoke`) run only when their
paths change. They verify the retained Needle/USE integration, pinned model digests and
the AI release gate; they do not download generative weights.

## On a `v*` tag

`.github/workflows/release.yml` builds and signs per-ABI APKs, the universal APK and the
AAB, scans every artifact, writes checksums and `release-manifest.json`, and publishes a
GitHub Release. The release type is derived from the tag: a prerelease suffix publishes
as a pre-release, a plain tag publishes as a normal release. Versions are asserted from
`package.json`, never bumped by the workflow.

`workflow_dispatch` on the same workflow is a signed-candidate dry path: it runs the
full gate and build but never creates a Release.

## Manual only

- `backend-deploy.yml` pushes pending migrations and deploys Edge Functions. It never
  runs on push or on a tag, because backend mutation must be explicit and verified
  afterwards.
- `web.yml` deploys the production web build on `main` pushes and manual dispatch.

## External gates that are never CI

Camera capture, push delivery, TalkBack, IME behaviour, real two-device chat and phone
photo import need real hardware. They are tracked as external gates and are never
reported as passing from a host test or a web build.
