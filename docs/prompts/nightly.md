# Nightly prompt improvement

The replay runs nightly on squire at **04:00 America/New_York** (`0 4 * * *`)
until the baseline pass rate is at least 90% on both tested models. The Beeline
scheduler owns DST conversion. Its surviving Room schedule is
`ea5594a0-42ec-49dd-8957-5582216ebedd` in #beeline
(`bb91a1c7-7cad-4fde-aafc-94fccb651ac8`), so archiving an implementation corner
will not cancel it.

lunchboxfortwo asked for this loop: raise the baseline with audited prompt
fixes instead of random paragraph removal, test each fix on a small and a large
model, and keep it only when the gain justifies its tokens. They delegated the
trade-off rule and the after-90% behavior to Ruby (D1 and D2 below).

The schedule uses the owner's OpenRouter key through vault `use_credential`;
no Actions secret or exported key is needed.

## Models and caps

Every arm replays on both models, called directly through OpenRouter:

- `openai/gpt-6-luna` — small (Baby's model)
- `openai/gpt-6.1-sol` — large (Speedy's model)

`--models` overrides the list; the default is both. gpt-6.1-sol rejects
disabled reasoning, so it runs with `reasoning: { effort: "low" }`; other models
run with reasoning disabled. OpenAI rejects strict schemas with free-form tool
arguments, so the response format is sent with `strict: false`; the controller
still validates every answer strictly and never repairs it. The run never orders Baby or
Speedy. A response whose `model` differs from the requested model is
`incomplete` for that model only. The production free-agent model
(`apps/server/src/free-agents.ts`) is not changed and is not one of the tested
models.

One ledger caps the whole run across both models: **15 million tokens and $12**
by default (`--token-cap`, `--cost-cap`). Expect about $8–12 per night while the
baseline is below 90%. Never raise caps silently.

## Nightly steps

1. **Audit.** Read the previous run's `result.json`. For each model, list the
   failing cases (baseline rows with `pass: false`) and their sample transcripts.
   Group failures by cause, not by case. Write one targeted patch to the prompt
   sources (`apps/body/src/**` or `apps/server/src/free-agents.ts`) that states
   a general rule fixing the largest cause group. Never copy case text, names or
   expected answers into the prompt. Write `audit.md` beside the patch: each
   failing case, its cause group, and the expected fix (or "not addressed").
   Do not change saved cases or pass rules.
2. **Replay.** Run the controller with `--candidate-patch`. It applies the patch
   in a temporary tree and replays baseline, unchanged control and candidate on
   each model with the same fixed seeds. A patch touching any other path, or a
   binary change, is rejected before any paid request.
3. **Decide (D1).** The controller keeps the candidate only if all hold:
   - pooled over both models' paired samples, the candidate beats baseline and
     the unchanged control in one-sided exact paired sign tests (each p < 0.025);
   - on neither model do losses exceed gains;
   - on each model, median tokens per turn grow at most 2% per percentage point
     of pooled pass-rate gain (`100 × (gains − losses) / paired samples`), and
     never more than 10% per run. Fewer tokens is always allowed.
4. **Propose.** On acceptance the controller writes `candidate.patch` and
   `proposal.md` (per-model before/after pass rates, gains, losses and median
   tokens). Open a normal repository corner from them, with `audit.md` in the
   brief. Normal independent review and merge gates apply; nothing auto-merges.
   The reviewer checks that the patch states a general rule, not case text.
   Tomorrow's baseline uses the improved prompt once it merges.

Without `--candidate-patch` and with any model below 90%, the run measures
baseline and control only and records `experiment: skipped: no audit candidate`.

## After 90% on both models (D2)

When the current baseline is at least 90% on both models and no patch is given,
the run uses the paragraph-removal (shortening) mode below, and acceptance also
requires both models' candidate pass rates to stay at or above 90%. Shortening
runs weekly: when the latest complete run reached the floor and a shortening
experiment ran within the last seven days, the controller exits with
`skipped: weekly shortening not due` and spends no tokens. An audit patch is
still replayed on any night it is given. If a baseline falls below 90%, the
nightly audit loop resumes.

## Run

Read the runner before executing it. Use a unique output and exchange directory
under the agent's persistent session home and one cumulative history file:

```sh
node --import tsx scripts/prompt-nightly.mjs \
  --out "$HOME/prompt-nightly/<run>/result" \
  --exchange "$HOME/prompt-nightly/<run>/exchange" \
  --history "$HOME/prompt-nightly/history.jsonl" \
  --candidate-patch "$HOME/prompt-nightly/<run>/candidate.patch"
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
All model tool calls are simulations and must never be executed, including
browser calls.

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

Three samples give 219 paired samples per arm per model for the current 73
eligible cases (438 pooled). The last one-model run used 3.2 million tokens.
Every run stops within its reservations and lists all budget-limited samples
explicitly.

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

Four concurrent requests per model share the run's token and dollar cap. Before each request,
reserve UTF-8 input bytes plus maximum output as a conservative token bound and
$0.10. Replace reservations with billed usage on response. A response costing more
than its reservation can cross the dollar cap; the controller then stops. Never
increase caps silently. Include incomplete costs in the result.

## Shortening experiment (after 90%)

Remove one complete literal paragraph from a render function in a temporary
source copy. Failing eligible baseline cases and skipped browser cases protect
their whole section, so unmeasured browser rules are not removal candidates. Rotate
the next eligible paragraph using cumulative history. A case failing on either
model protects its section. Structural validation must
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
These numbers are per model; pooling both models doubles the paired samples.
A removal proposal additionally requires no passing sample to regress, lower
pooled median tokens per turn, and both models at or above 90%. Safety/authority paragraphs are always protected. The controller
writes `proposal.md` and candidate source only after these conditions hold.
Open a normal repository corner/PR for a proposed removal under current work
authority; normal independent review and merge gates still apply.
The same paired tests apply to audit patches, pooled over both models, with D1
replacing the removal-only conditions.

## Publish and retain

Keep `result.json`, `summary.txt`, and cumulative `history.jsonl` under the session
home. Post the result and history as artifacts in the schedule’s Room and publish exactly
one summary line per run on the repository issue **Prompt nightly results**.
The line names each model's baseline pass rate, the tested change and whether it
was kept, plus the pooled pass rate, skipped count, median tokens/turn, total
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

## Two-model result (schema version 3)

Top-level `baseline`, `control` and `candidate` rows pool both models; each row
has `model` and an id of `<model>:<case id>`, so pairing never crosses models.
Top-level scoring fields (`passed`, `scoredCases`, `passRate`, ...) are pooled
over both models; their denominator is eligible cases × models. History adds
`floorReached` and `models: { <id>: { passed, scoredCases, passRate,
medianTokensPerTurn, experiment } }`; `model` lists the models comma-separated.
`experiment` adds `mode` (`audit`, `shorten` or `none`), the patch paths and
sha256, D1 fields (`gainPoints`, `tokenAllowance`, `tokenGrowth`) and
`perModel` gains, losses, tokens and pass rates. Every earlier top-level history
field is kept, and older lines need no migration.

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

Run-level `scoring` records baseline `passed`, `scoredCases`, `unscoredCases`,
`formatInvalidCases`, `passRate`, and `overallPassRate`; history stores these fields at the top level.
Only cases with every fixed sample behavior-scored enter `scoredCases`.
`passed` and `passRate` are null when that denominator is zero, and the summary
says `no behavior verdicts` with the separate format-invalid case count. A subset rate names its denominator
and unscored case count; `overallPassRate` remains null unless all eligible cases
are scored. The legacy `cases` history field remains the eligible cohort size,
not the behavioral denominator. `complete` describes finished simulation, not
successful behavior or valid format; class counts retain that distinction.


For a measurement repair proof, pass `--label "measurement-repair run"`, post
result and summary in its implementation corner, and do not publish that run as
a nightly score on the results issue. A partial run remains useful evidence when
its missing data and cost are explicit; it cannot propose a removal.
