# Beeline capability discovery

This cohort measures whether a person can find and use Beeline features by
asking normally. The corpus is [beside the saved prompt cases](cases/discovery/corpus.json):
sixty requests, including Arabic and the requested anonymized churn phrasings.
Each records an `action`, `feature` or `unsupported` outcome, the expected next
step, capability/full rules, forbidden actions and the skill text to inspect
when it fails. It does not change production skills or Nerd's configuration.

## Run

Prepare the checkout with `npm run corner:prepare`. Deliberately run:

```
npm run prompt:discovery -- --run --profile "$HOME/nerd-discovery-profile.json" --out "$HOME/discovery-$(date +%s)"
```

Use `--only usage,schedule-cleanup` for a targeted smoke. From Nerd’s own
normal session, `--grok-home "$GROK_HOME"` provisions the fixture through that
existing signed-in harness home rather than the owner’s shared CLI login. It
links the directory through a private temporary operator bridge and uses the
standard provisioner; it never reads or prints raw credentials. Every output directory
must be new; earlier observations are never overwritten. The runner uses the
installed `grok` ACP program, Grok 4.7 and xhigh, matching the live Nerd member
snapshot recorded for this assignment. It does not send cases to OpenRouter or
replace the model. It uses the owner's existing normal Grok login through the
standard agent-home provisioner; a provider refusal must be repaired on that
route, never silently substituted with another model/account.

The local Workspace has fixture owner/member identities and an agent, no repository, no real users,
no external provider adapters and no host-route grants. Each case gets a fresh
Room and conversation. The launcher removes external shared skills from the isolated harness home immediately before launching Grok; only Beeline-owned skills remain. The production
ThinDaemonCore, prompt assembler, ACP client, permission boundary and MCP server
run against the local HTTP service and disposable PGlite database. Files are
written inside private session storage. The MCP audit wrapper records original
names/arguments and returned success or refusal. It intercepts merges, approval,
release, host commands, orders and external writes as intent only.

This is a harness clone, not a production command to the live Nerd identity.
Pass `--profile <file>` containing the live `agentId`, `model` (`grok-4.7`),
`effort` (`xhigh`) and `soul` (`name`, `instructions`) from Nerd’s authorized
configuration read. The runner hashes this snapshot into its result and copies
the soul into the disposable fixture; it never updates the live agent. Without
a snapshot the fixture has a neutral persona and can only be a smoke test.
Before calling a run an as-configured Nerd baseline, confirm the normal login route; the incomplete attempts are explicitly not a completed baseline. Nerd subsequently supplied an as-configured smoke with its profile hash in `cases/discovery/nerd-smoke.json`; that normal signed-in route hit the same provider balance refusal. Never infer identity/configuration parity from the display name.

No schedule worker runs in the fixture. Created reminders cannot dispatch real
work. The cleanup case must create then delete its reminder; remaining rows are
recorded before controller teardown, which removes any leftovers regardless of
score. Artifacts are uploaded through the real local validator/storage path.
The test suite demonstrates both paths without spending model tokens.

## Score and retain

`result.json` retains the model, effort, CLI version, source commit, per-case
transcripts, intended calls, returned MCP outcomes, local effects and grades.
`pass` needs the right capability and next step/arguments. `partial` means the
capability is right but the next step is wrong. Forbidden behavior fails even
when another clause passes. A refused call cannot pass a full action rule.
Infrastructure failures and unrun cases are `incomplete`, excluded from the
completed-only rate; the overall rate is null until every case completes.

Tool/argument rules are deterministic. Text matchers are screening rules, not a
semantic guarantee. Review their matches against the checked-in
[judge prompt](cases/discovery/judge.md); only wording may be judged by an LLM.
Keep the judge's model, input, output, short evidence quote and case ID with the
run. A wording judge cannot override forbidden actions, tool failures, persisted
effects, completion or cleanup. Until that review, text grades are provisional and the overall pass rate is null.
The runner exports `judge-inputs.json`. Each wording judgment must additionally
record `model`, `rubricSha256` (the prompt hash) and `transcriptSha256` (from
`transcriptHash` in the scorer), binding it to the exact observed transcript.
After saving a judgments array, apply it without rerunning Nerd:

```
node --import tsx scripts/discovery-grade.mjs --run /path/result.json --judgments /path/judgments.json --out /path/judged.json
```

Stale judgments and absent evidence remain provisional. Never report a simulated/intended action as performed.

Rank observed partial/fail cases by user impact and frequency. For each, quote
what Nerd actually did, link its case/transcript, and name the specific missing
skill/tool instruction. Send gaps to Ruby for follow-up corners. A skill fix must
pass its previously failing case and preserve every previous pass; no skill
fixes belong in this harness/corpus change.

## Sunday replay

The existing Jellybean schedule runs Sunday 04:00 America/New_York. Its prompt
also requests this cohort after the existing replay, once this harness is on
main. Keep the existing prompt replay's six-million-token/$3 limits unchanged;
this cohort uses the normal Grok subscription rather than the OpenRouter file
transport. Do not incur a new paid API bill or replenish a balance implicitly.
Stop on an infrastructure refusal and report an incomplete cohort. Publish its
result separately beside the existing prompt replay artifacts and include both
in the same results-issue summary. Never mix the free-agent/removal experiment's
rate with Nerd's capability-discovery rate. This corpus is not an eligible
paragraph-removal experiment arm.

Run `npm run test:prompt-discovery` for deterministic grading, real local
schedule cleanup, real artifact upload and unsafe-call interception. CI runs
these controls without calling a model.
