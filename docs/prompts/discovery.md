# Beeline capability discovery

This cohort measures whether realistic user requests lead to the right Beeline
capability and next step. The [corpus](cases/discovery/corpus.json) contains sixty
English/Arabic requests, including the anonymized churn phrasings. Each records
an `action`, `feature` or `unsupported` outcome, capability/full rules, forbidden
behavior and the skill text to inspect when it fails. Production skills and the
live agent's configuration are outside this change.

## Nerd's actual configuration

The agent's model name does not identify its harness. The authorized live
configuration read for this assignment returned harness `cursor`, selected model
`grok-4.7-xhigh`, selected effort `null`, and plan `Ultra`. Extra High is part of
Cursor's complete model ID; splitting it into a Grok CLI model and effort flag
changes providers. Use the production `cursorAcpBridgeLaunch` and the installed
`cursor-agent`, exactly as Room sessions do.

Earlier Grok CLI attempts, including Nerd's delegated attempt, are invalid as
Nerd baselines. They loaded the separately provisioned Grok sign-in and received
a Grok Build refusal, not a Cursor allowance verdict. See the retained
[routing diagnosis](cases/discovery/routing-diagnosis.md). Do not ask the owner
to replenish Cursor credit on the strength of those attempts.

## Run

Prepare the checkout with `npm run corner:prepare`. Save the authorized live
profile privately as JSON with `agentId`, `harness: "cursor"`,
`model: "grok-4.7-xhigh"`, `effort: null` and the current `soul` object. The
runner rejects a profile with another harness or an incomplete model ID. It
copies that soul only into the disposable fixture, records a profile hash, and
never updates the production agent. Without a profile a run is a smoke only,
with no official overall pass rate.

```
npm run prompt:discovery -- --run --profile "$HOME/nerd-discovery-profile.json" --out "$HOME/discovery-$(date +%s)"
```

Use `--only usage,schedule-cleanup` for a targeted smoke. Every output directory
must be new. `--operator-home <directory>` selects the current owner's existing
normal login through Beeline's standard home provisioner; no raw credential is
read or printed by this controller. Keep model, harness and account unchanged.
Do not substitute a model API or provision another account after a refusal.

The local Workspace has fixture owner/member identities and one agent, no
repository, no real users, no external provider adapters and no host grants.
Each case gets a fresh Room and conversation. The launcher removes external
shared skills from its isolated Cursor home, leaving Beeline-owned skills. The
production ThinDaemonCore, prompt assembler, Cursor ACP bridge, permission
boundary and MCP server talk to a local HTTP service and disposable PGlite DB.
The audit trace lives in the writable session home; its path is passed explicitly
to the MCP wrapper so a provider's environment filtering cannot break it.

Safe calls execute through that service. External account connection setup,
merges, approval, release, host commands,
orders and external writes are intercepted as intent only. No schedule worker
runs, so reminders cannot dispatch real work. The cleanup case must create then
delete its reminder; remaining rows are measured before teardown removes any
leftovers. Artifacts go through the real local validator/storage path.

## Score and retain

`result.json` retains the harness/model, CLI version, commit/source hashes,
per-case transcripts, intended calls, MCP success/refusal, effects and grades.
Pass needs the right capability and next step/arguments. Partial means the
capability is right but its next step is wrong. Forbidden behavior fails even
if another rule passes. A refused or merely planned safe call cannot count as
performed. A harness deadline does not erase an already successful required
action: its row can pass on recorded calls and effects while its turn stays
incomplete. `turnsCompleted` counts finished turns separately from scored rows.
Provider/startup failures, unproved actions and unrun cases remain incomplete;
the overall rate is null until every case has a supported score.

Output directories must sit outside every Git checkout. The runner rejects a
nested path so the test agent cannot infer the implementing corner from its
working directory. The local service has an empty, enabled memory store. The
historical-file case uploads a real CSV attachment, and the workflow-read case
starts a real paused workflow. Their template identifiers are replaced with
service-generated IDs and retained as `bindings` alongside the observations.

Tool/argument rules are deterministic. Text matchers are provisional screens.
Use only the checked-in [wording judge prompt](cases/discovery/judge.md) for
semantic wording judgments. The runner exports `judge-inputs.json`. Keep each
judgment's `caseId`, `model`, `status`, `reason`, exact short `evidence` quote,
`rubricSha256`, and `transcriptSha256` (from the scorer's `transcriptHash`).
The judge cannot override tool failures, forbidden actions, effects or cleanup.

```
node --import tsx scripts/discovery-grade.mjs --run /path/result.json --judgments /path/judgments.json --out /path/judged.json
```

This preserves the original run and records the grading source hashes separately
from the execution source hashes. Missing or stale judgments stay provisional,
and the official rate remains null. Rank observed partial/fail cases by user
impact and frequency; include the actual behavior, linked case/transcript, and
specific missing skill/tool instruction. Send the gaps to Ruby, who opens fix
corners. Each fix must pass its previously failing case without losing an
existing pass. No skill fixes belong in this harness/corpus change.

## Retained preliminary Cursor run

The [first retained attempt table and ranked gaps](cases/discovery/cursor-baseline.md)
and [per-case evidence](cases/discovery/cursor-baseline.json) cover the complete
corpus attempt. They are preliminary: deadlines leave cases incomplete and the
current wrapper intercepts safe local Room replies. The System DM member-case
rule also rejects any post, including a harmless refusal in the fixture Room.
Do not publish these counts as an official overall rate or as proof of a
broadcast. The report records the harness corrections required before that rate
is supported. The [Cursor smoke](cases/discovery/cursor-smoke-confirmed.json)
separately proves usage and real schedule creation/deletion.

## Sunday replay

The existing Jellybean schedule runs Sunday 04:00 America/New_York and requests
this cohort after the harness lands on main. Keep the original prompt replay's
six-million-token/$3 limits unchanged. Discovery uses Nerd's normal Cursor
subscription, not the OpenRouter transport. Do not turn on paid overages or
replenish a balance implicitly. Report provider/configuration failures with
host and credential source, not a guessed billing explanation.

Publish discovery separately beside the weekly replay artifacts and include
both results in the same results-issue summary. Do not mix Nerd's rate with the
free-agent/removal experiment's rate or use this cohort as a removal arm.

Run `npm run test:prompt-discovery` for grading, profile/harness validation,
local schedule cleanup, artifact upload and unsafe-call interception. CI runs
these controls without calling a model.
