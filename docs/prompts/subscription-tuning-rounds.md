# Tuning decisions (tune partition only)

Held-out results have not been opened or used for these choices.

## Round zero continuation

Earth returned its complete attempted tune cohort (54 cases per variant): full
passed 33/41 scored cases, deferred passed 34/40. Unscored counts were 13 and
14. Its median aggregate input grew from 46,898.5 to 66,801 with deferred
loading. Local Luna and Sol runs were interrupted before completion; resume
their saved samples rather than generate replacement seeds. Their results must
be included before any frontier or stopping decision.

## Round one candidates

These candidates are selected from Earth's completed round-zero failure groups
and token accounting. They are independent changes from r0-deferred, not a
combined winner. Each must run on every available assigned model.

- `r1-short`: cap advertised descriptions at forty words. Change only description
  length. Deferred round zero increased Terra's aggregate input, so test whether
  shorter repeated MCP listings reduce continuation bloat. Schemas stay intact.
- `r1-order`: add `order` to the fully loaded core. Change only core count.
  Terra's deferred `finish-orders-then-ends` sample made no calls, while its full
  counterpart passed. Making the terminal assignment tool immediately callable
  tests this discovery failure without adding a new prompt rule.

Neither choice is a recommendation or a frozen frontier. Compare paired scored
cohorts and retain raw exclusions. The full baseline and round-zero deferred
samples remain the original runs; do not rerun them to improve scores.

## Round two candidates

Round-one Luna and Terra completed all tune attempts. Sol is resuming its
remaining saved samples; no replacement samples are taken. The following
choices use only observed round-one tune failure groups, not held-out data.

- `r2-full-short`: full loading with forty-word descriptions, changing only
  description length against full. Both round-one deferred variants increased
  aggregate input on Luna and Terra; test shortening without discovery overhead.
- `r2-boundary`: add one terminal-boundary rule to `r1-order`. Repeated
  call-after-terminal failures occur on Luna and Terra, so test explicit stopping
  language while retaining the same core and descriptions.

These are candidates, not a frozen frontier or a stopping decision.

## Round three candidate

All three round-two arms attempted the full tune cohort. The boundary variant
is rejected for Luna's paired regression (over five points). Round one improved
the best mean scored accuracy by more than three points, so round two alone
does not satisfy the two-consecutive-round stopping rule. Held-out remains sealed.

- `r3-full-shorter`: reduce full descriptions from forty words to twenty; change
  only description length against `r2-full-short`. This candidate predates the
  accounting correction below. Its local runs remain incomplete; do not rank it.

## Token accounting correction: new rounds paused

The original input metric is the aggregate `turn.completed` usage for a case,
not input per model call. It cannot establish the size of the Beeline prompt.
Saved events have neither request-level token splits nor model-call counts.

The offline audit counts the initial Beeline-owned prompt separately with
`js-tiktoken@1.0.21` and `o200k_base`. It includes replay instructions, the skill
index, serialized initial MCP definitions and deferred purpose lines; it excludes
the case conversation and Codex envelope. This is an initial-call proxy, not an
exact median across requests after definitions load. Codex totals remain separate.

Recount saved tune results without calling a model:

```sh
node --import tsx scripts/prompt-token-audit.mjs .beeline-proof/token-audit.json \
  .beeline-proof/subscription-round-{0,1,2,3}/{luna,sol,terra}/result.json
```

The script reports cumulative round comparisons, retention changes, and every
unscored simulator call. Partial candidates do not shrink completed candidates'
comparison cohorts. Reconstructed prompts are marked separately from saved ones.
The provisional round-two frontier changes from `r1-order`/`r2-full-short` to
`r1-short`/`r1-order`. Missing simulated facts still exclude cases, so neither this
frontier nor the earlier stopping argument establishes an optimum. Repair
simulator coverage and request telemetry before further tuning or held-out runs.

Persisted diagnostic rollouts subsequently showed that Codex itself defers the
MCP definitions in both arms. The initial-call proxy above is therefore a
nominal server-config count, not observed model exposure; it is withdrawn as
selection evidence. The corrected report uses actual exposed/retrieved
definitions per call and requires complete rollout telemetry and grading.
Existing variants remain unchanged. Only missing-data repairs are authorized;
new tuning rounds and held-out evaluation remain paused for the owner's report.
