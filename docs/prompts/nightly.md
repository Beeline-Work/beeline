# Nightly prompt optimization

`.github/workflows/prompt-nightly.yml` replays every saved prompt case at 04:00
America/New_York. GitHub cron uses UTC, so two triggers cover EDT and EST and a
clock gate selects exactly one. GitHub can delay scheduled runs. This job lives
in the repository rather than a corner schedule, which is cancelled on landing.
It supports a manual `workflow_dispatch` for verification and recovery.

Setup requires the repository Actions secret `OPENROUTER_API_KEY`, authorized
for the same provider as the free-agent model, and the repository setting that
allows Actions to create pull requests. Never put a key in source, an artifact,
an agent prompt or a command argument. The implementation reads the production
default from `free-agents.ts`; it fails if that declaration cannot be read. If
production overrides `BEELINE_FREE_AGENT_MODEL`, reconcile that override before
using these measurements as production evidence. No model is changed by this job.

Each case gets a fresh simulated turn, with the actual assembler, tool schemas
and managed skill descriptions. Tools are simulated, never executed. A requested
skill body is supplied only after its Read, then the same turn resumes, for at
most six rounds. The runner disables optional reasoning with a 4,096 output
token ceiling, consistently on baseline and candidate. Truncated and malformed
answers fail; provider/transport failures make the run incomplete and suppress
proposals. Off-model responses or missing token/cost accounting also stop the run.

The existing sampling rule applies: one passing first sample passes; a failing
first sample gets two additional samples and needs two passes out of three.
Tokens per turn means all billed input, output and reasoning tokens across one
complete simulated turn, including skill continuations. Each case records its
median, and the overall value is the median across sampled turns. The run also
records total billed tokens and dollar cost, including the removal experiment.

There are four concurrent requests, a six-million-token cap and a $3 cost cap.
Before requests, the ledger reserves UTF-8 input bytes plus maximum output as a
conservative token bound, and $0.10 per concurrent request. Provider accounting
replaces reservations after each response. A provider response above the dollar
reservation can cross the cost cap by that response; the runner then stops. At
the current model's rates that reservation is deliberately generous. Incomplete
runs remain visible and cannot produce a proposal. Do not increase caps silently.

One experiment removes one complete literal paragraph from a prompt render
function. A failing baseline case protects its entire section. The history rotates
the next eligible paragraph; sections without literal paragraphs are not removal
candidates. The candidate is assembled from a temporary source copy and must
still validate every case. Baseline and candidate use the same case library and
model. A proposal requires no previously passing case to regress, an overall
pass rate at least as high, and a lower overall median tokens per turn. A failed
experiment is recorded without changing production prompts.

A successful experiment opens a unique `automation/prompt-removal-<run>-<attempt>`
branch with the measured numbers, without force-pushing. It explicitly dispatches
the checks and prompt-case workflows because a workflow token's push does not
trigger pull-request workflows. It never merges. Structural prompt tests must pass before a PR
is opened; CI and an independent reviewer still decide whether to keep the change.
The job regenerates prompt snapshots alongside the candidate so the reviewer can
inspect the rendered change. Failure at this validation step leaves the proposal
unopened and the run marked failed by GitHub, with replay evidence retained.

Every run publishes a short comment to the repository issue **Prompt nightly
results**. The 9am digest reads the newest comment and follows its run URL for
evidence. The run summary includes pass rate, median tokens per turn, nightly
token cost and experiment outcome. A job failure is shown alongside the replay
result so a successful replay cannot hide a failed proposal or publication.

Artifacts retain per-case samples and provider usage for 90 days. The history
artifact includes `history.jsonl`, with one row per run and per-case medians;
the next run restores it before appending. This preserves cumulative history
as long as the job runs within the retention window. A missing history artifact
starts a new series; a failed download stops the run rather than silently losing
history. The issue comments remain the durable daily index.

## Gap rule

Every real agent failure from Sentry, feedback triage or the workspace walk must
be turned into a redacted case before its prompt fix. Use invented names and
paraphrase the incident. Record the source incident reference privately in the
corner brief. Replay the new case on the old prompt and save the failing result;
then replay the fix with the entire library. The new case must pass, no previously
passing case may regress, and the overall pass rate must not drop. A case-only
PR may record an unresolved failure; it does not justify lowering a pass rule.
Deterministic validation alone does not establish behavioral pass rate.

## Local verification through sealed Squire

Run `npm run prompt:nightly -- --out .scratch/prompt-nightly/proof --exchange
.scratch/prompt-nightly/exchange`. The controller writes numbered request JSON
files and waits up to three minutes for each response. For each request, the
Beeline agent calls Squire `use_credential` against OpenRouter, using its owner's
authorized connection. Save only the upstream JSON body as the matching numbered
`.response.json` file, atomically. Never run any simulated tool call. Keep this
controller active until `result.json` says complete or incomplete. This uses the
same runner as CI while keeping the provider key outside the agent and process.

`npm run test:prompt-nightly` exercises budget reservations, case protection,
experiment acceptance, skill continuations and fail-closed provider handling
without spending model tokens.
