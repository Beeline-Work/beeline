# Nightly prompt optimization

Jellybean runs the Beeline schedule `e4ef62d4-6277-46cf-aa2c-fdc00912fdd7` on
squire at **04:00 America/New_York** (`0 4 * * *`). The Beeline scheduler owns
DST conversion. The schedule was created in corner
`04c16cad-a28b-4477-8817-4a25d2be4125`, as Ruby directed. It uses the owner's
OpenRouter key through vault `use_credential`; no Actions secret or exported key
is needed. The GitHub nightly workflow was removed.

**Landing archives this corner and cancels its schedule.** The commander must
migrate the schedule to a surviving Room before landing. List existing schedules
first to avoid duplicates. Do not claim the archived schedule remains active.

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
schemas and managed skill descriptions. Requested skill bodies are returned only
after their Read; the same turn resumes for at most six rounds. The model has a
4,096 output-token ceiling with optional reasoning disabled on both arms.
Malformed or truncated answers fail. Provider/transport failures, off-model
responses and missing usage accounting mark the run incomplete and suppress
proposals.

Use the existing sampling rule: one passing first sample passes; a failing first
sample gets two more and needs two passes out of three. Tokens per turn include
all billed input/output/reasoning across skill continuations. Record each case's
median and the median across sampled turns, plus total tokens and dollar cost.
Keep the baseline and candidate cohorts identical.

Four concurrent requests share a six-million-token/$3 cap. Before each request,
reserve UTF-8 input bytes plus maximum output as a conservative token bound and
$0.10. Replace reservations with billed usage on response. A response costing more
than its reservation can cross the dollar cap; the controller then stops. Never
increase caps silently. Include incomplete costs in the nightly result.

## One removal experiment

Remove one complete literal paragraph from a render function in a temporary
source copy. Failing eligible baseline cases and skipped browser cases protect
their whole section, so unmeasured browser rules are not removal candidates. Rotate
the next eligible paragraph using cumulative history. Structural validation must
still pass for the entire library, including skipped cases. Replay every eligible
case against the candidate. Retain rejected outcomes without changing prompts.

A proposal requires no passing case to regress, no overall pass-rate decrease,
and a lower median tokens/turn. The controller writes `proposal.md` and the
candidate `prompt-assembly.ts` only when those conditions hold. Open a normal
repository corner/PR for the measured removal under current work authority;
regenerate snapshots and run structural/body tests. Use the normal independent
review and merge gate; never merge automatically. This corner's immediate
experiment may be included in PR 2709 if accepted. Rejected experiments need no
prompt change.

## Publish and retain

Keep `result.json`, `summary.txt`, and cumulative `history.jsonl` under the session
home. Post the result and history as artifacts in this corner and publish exactly
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
