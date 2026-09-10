# Production release pipeline

`Unified production release` is the only workflow that releases current
`main`. It is manually dispatched; merges do not trigger a production release.

The initializer compares the selected main SHA with the last successful
`unified-release-index` and writes `release-plan.json`. Its explicit path map is
`COMPONENT_PATH_RULES` in `scripts/unified-release.mjs`. The plan selects
`server`, `helper`, `mobile-ota`, `mobile-native`, `desktop`, and `website`
independently. `selection=all` is the deliberate full-release override. A
non-`none` store track always selects `mobile-native`.

Selected jobs build immutable artifacts named with both release version and
source SHA, promote them, run bounded checks, and publish a component
checkpoint. Unselected entries retain the prior release's version, SHA, and
artifact reference. All selected component jobs run concurrently. Shared
protocol and UI changes select every real consumer, while their deploy
contracts stay independently backward-compatible; no fleet-convergence or
artificial cross-component gate serializes them.

A failed attempt stores its release state. Up to two automatic retries use the
same version and SHA, skip checked components, reuse successful immutable build
artifacts, and rerun only unfinished component work. Missing identities,
unknown selections, missing carried references, and absent selected artifacts
fail closed. Helper fleet uptake is recorded once as post-release observability;
installed-helper convergence never gates delivery.

Normal selective attempts have a 20-minute dispatch-to-result budget. Component
jobs have shorter explicit timeouts and network smoke checks have second-scale
limits. The final index records outcome, duration, selected/carried components,
and a failure class (`budget` or the unfinished component list).

## Reliability measurement

The workflow summary reports failed attempts over the latest 20 completed
manual `unified-release.yml` runs, using GitHub Actions run conclusions. It
surfaces the percentage only after at least 10 completed attempts; before that,
it reports the sample as insufficient. The target is fewer than 10% failed
attempts. This is an operating metric, not a claim that one change or one
successful release proves the target.

Review the planner without deploying by running:

```sh
node --test scripts/unified-release.test.mjs
```

Those fixtures cover component selection, shared-path fanout, carry-forward,
same-identity selective retry, missing artifacts, and the workflow time budget.
