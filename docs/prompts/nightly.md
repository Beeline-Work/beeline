# Weekly prompt optimization

The replay runs weekly on squire, Sundays at **04:00 America/New_York**
(`0 4 * * 0`). The Beeline scheduler owns DST conversion. Its surviving Room
schedule is `ea5594a0-42ec-49dd-8957-5582216ebedd` in #beeline
(`bb91a1c7-7cad-4fde-aafc-94fccb651ac8`), so archiving this implementation corner
will not cancel it. The old corner schedule
`e4ef62d4-6277-46cf-aa2c-fdc00912fdd7` was deleted to avoid duplicate runs.

The weekly cadence was approved by lunchboxfortwo and relayed through Ruby.
Ruby confirmed the surviving Room schedule is weekly, with its next run on
Sunday 2026-10-25, 04:00 EDT / 08:00 UTC. Both corner schedule-list reads
returned `schedules: []`; there is no remaining corner copy.

The schedule uses the owner's OpenRouter key through vault `use_credential`;
no Actions secret or exported key is needed. The GitHub replay workflow was removed.
Keep the schedule, model and budget caps unchanged. The controller owns the measurement rules below.

## Run

Read the runner before executing it. Use a unique output and exchange directory
under the agent's persistent session home and one cumulative history file:

```sh
node --import tsx scripts/prompt-nightly.mjs \
  --out "$HOME/prompt-nightly/<run>/result" \
  --exchange "$HOME/prompt-nightly/<run>/exchange" \
  --history "$HOME/prompt-nightly/history.jsonl"
```

The controller writes numbered `*.request.json` files. The answering Beeline
agent services each using Squire `use_credential`: POST the exact JSON body to
`https://openrouter.ai/api/v1/chat/completions`, with the owner's Openrouter
credential injected in the Authorization header by the vault. Inspect credential
metadata to select the existing agent key. Never fetch a key or place it in a
process, file, prompt, log or Actions secret. Save only the upstream response
body atomically as the matching `*.response.json`. On refusal, return an explicit
`{"error":"<redacted reason>"}` response; never invent a model answer. Keep the
controller running until it exits. Missing responses time out after three minutes.
A fresh exchange directory prevents stale responses from being reused.

The model comes from the production default in `apps/server/src/free-agents.ts`.
If production overrides that default, reconcile before treating the measurements
as production evidence. The job never changes the model. All model tool calls are
simulations and must never be executed, including browser calls.

## Cohort and measurements

Three saved cases require browser sessions and are recorded as `skipped:squire`:
`squire-busy-request-capability`, `squire-drive-starts-drive`, and
`squire-long-history-host-recovery`. They are excluded from both arms and the
pass-rate denominator. A shipped-status text case that merely advertises a
browser tool remains eligible. Browser dependencies are detected from required
browser calls or session-ownership transcript fixtures; tests pin this cohort.
New real browser-dependent cases must extend this coverage, never silently vanish.

Each eligible case gets a fresh simulated turn with the real assembler, tool
schemas and managed skill descriptions. A typed `scenario` on each saved case
contains only environment facts: brief, history, checks, connection status, usage,
files, and argument-matched tool results. A skill body is returned only after its
Read. The controller validates calls against their advertised schemas, supplies
results, and resumes until a final reply (including silence), an approval or
blocked/error boundary, or the existing six-round limit. It never executes a
simulated call. Missing scenario facts are `incomplete`, never invented success.
Legacy `toolResults` remain readable while fixtures migrate to argument matching.
Compound shell observations compose only case-recorded command results and file
contents. Quoted separators stay literal; pipes support only `head`. No shell is
invoked. Unknown commands, paths, redirects or substitutions remain explicit
missing facts rather than receiving a successful default.
Native argv commands and Bash commands share argument matching and recorded
facts, including the same forbidden-command assertions. Raw calls keep their
original names and arguments in the result.

Each case receives exactly three independent samples in baseline, unchanged control,
and candidate, with sample-index seeds paired across arms. There is no stopping
after a success. Seeds aid pairing; they do not promise provider determinism.
Each row reports behavior pass proportion and a Wilson 95% interval. With three
samples these intervals are intentionally wide.

Three samples increase the paired cohort to 219 samples per arm for the current
73 eligible cases. The previous two-sample run cost $0.18 but used 3.69 million
tokens; the unchanged six-million-token cap, rather than the dollar cap, limits
sampling growth. Every run still stops within its existing reservations and
lists all budget-limited samples explicitly.

Output uses a JSON schema response constraint and requires providers to support
the requested parameters. Raw output is parsed strictly, without extracting or
repairing JSON. `format` samples have no behavior verdict. Invalid callable tool
names or arguments return validation errors to the same simulated turn and allow
retry within the six-round limit. Invalid attempts are counted separately and
retained verbatim; only valid calls satisfy positive behavior rules. A turn that
finishes or exhausts its rounds without any valid call after validation errors
fails behavior. Forbidden attempts still fail safety rules even if rejected by
validation. Fixture addresses are UUIDs, including references in tasks and rules.
Truncation, transport failures, absent
usage, missing scenario facts, round limits and exhausted budgets are
`incomplete`, with an explicit terminal reason. A format/incomplete sample never
passes a negative-only rule. The restart fixture also records a separate
truthfulness verdict; truthful inability is distinct from successful completion.
Tokens include every continuation, and every round retains raw output, upstream
response, usage and simulated results. The output ceiling remains 4,096 tokens.

Four concurrent requests share a six-million-token/$3 cap. Before each request,
reserve UTF-8 input bytes plus maximum output as a conservative token bound and
$0.10. Replace reservations with billed usage on response. A response costing more
than its reservation can cross the dollar cap; the controller then stops. Never
increase caps silently. Include incomplete costs in the weekly result.

## One removal experiment per weekly run

Remove one complete literal paragraph from a render function in a temporary
source copy. Failing eligible baseline cases and skipped browser cases protect
their whole section, so unmeasured browser rules are not removal candidates. Rotate
the next eligible paragraph using cumulative history. Structural validation must
still pass for the entire library, including skipped cases. Replay every eligible
case against the candidate. Retain rejected outcomes without changing prompts.

The unchanged control estimates baseline/control sample flips. The removal
comparison pairs case and sample index, reporting gains, losses and an effect
interval. It is **too little data** when cohorts are missing or unscored, the
candidate does not beat both baseline and unchanged control in one-sided exact
paired sign tests (each p < 0.025). Unsigned control flips describe variability,
not an expected positive gain; increasing samples cannot make a net-gain-greater-
than-all-flips rule sensitive to smaller effects. Control gains, losses and signed
drift are reported alongside the flip rate and the paired effect interval.

The smallest resolvable improvement with no losses is six discordant gains
(6/219, about 2.74 percentage points). That is a significance threshold, not a
power guarantee. At the prior control flip rate (12/102), a planning approximation
for 80% power at two-sided 5% is `2.8 * sqrt(2 * flipRate / pairedSamples)`:
about 9.2 percentage points with 219 complete pairs. The run reports this
noise-dependent estimate as `detectableEffect`, floored at the six-gain threshold;
it assumes independent paired samples and comparable discordance across arms.
Actual detectability depends on discordance and how gains distribute between
cases; three samples cannot resolve tiny per-case effects.
A proposal additionally requires no passing sample to regress and lower median
tokens per turn. Safety/authority paragraphs are always protected. The controller
writes `proposal.md` and candidate source only after these conditions hold.
Open a normal repository corner/PR for a proposed removal under current work
authority; normal independent review and merge gates still apply.

## Publish and retain

Keep `result.json`, `summary.txt`, and cumulative `history.jsonl` under the session
home. Post the result and history as artifacts in the schedule’s Room and publish exactly
one summary line per run on the repository issue **Prompt nightly results**.
The line includes eligible pass rate, skipped count, median tokens/turn, total
tokens/cost and experiment outcome. The saved 9am morning-card procedure reads
the newest comment and artifact evidence. If publication fails, report that
failure instead of claiming the digest has a result. Never treat stale output as
current health. Preserve the history artifact before archive or schedule migration.

Night zero is preserved in `night-zero.json`: **40 passed / 59 completed** out of
70 cases, with all 11 incomplete IDs and reasons. It is an incomplete historical
observation, not the denominator for the new 67-case cohort or an experiment arm.

## Gap rule

Every real agent failure from Sentry, feedback triage or the workspace walk must
become a redacted failing case before its prompt fix. Use invented names and
paraphrase incidents; retain private source references in the brief. Replay the
new case on the old prompt, then the fix with the entire eligible library. The
new case must pass, no passing case may regress, and overall pass rate must not
drop. Browser cases stay explicitly skipped until a separately authorized replay
can exercise them. Structural validation alone does not prove model behavior.

`npm run test:prompt-nightly` tests controls without spending model tokens.

## Result and history compatibility

`result.json` schema version 2 retains `baseline`, adds `control` and `candidate`,
and records per-arm sample class counts (`pass`, `behavior`, `format`,
`incomplete`). `pass: null` means behavior was not scored. Per-case rows retain
`pass` (now null when samples are unscored) and add `status`, alongside `passed`, `scored`, `proportion`, `interval`
and fixed `samples`. Each sample includes its seed and raw `rounds`.
It also includes valid `transcript.calls`, all `attemptedCalls`, and rejected
`invalidCalls` with validation results. Per-arm `diagnostics` separately counts
invalid calls and scenario incompletes, and lists every incomplete case/seed and
reason. The summary lists the same incomplete reasons; JSONL history retains
these diagnostics without requiring old lines to contain them.
`experiment` includes paired gains/losses, `noiseFlips`, `noiseRate`, `noisePairs`,
`effectInterval` and verdict; `noise` also retains the baseline/control comparison
when there is no eligible removal. Summary and JSONL history retain the old
fields and add schema version, class counts and per-case intervals. Old JSONL
lines need no migration: paragraph rotation still reads the last block ID.

For a measurement repair proof, pass `--label "measurement-repair run"`, post
result and summary in its implementation corner, and do not publish that run as
a weekly score on the results issue. A partial run remains useful evidence when
its missing data and cost are explicit; it cannot propose a removal.
