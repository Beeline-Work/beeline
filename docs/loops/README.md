# Beeline daily loops

Versioned skills are the source of the saved procedures, not extra prompts
pasted into schedules. All times use **America/New_York**, including DST.
[Shared contract](contract.md): current-release evidence first, systematic
questions, concrete problem → fix tuples, explicit OPEN QUESTION, shared dedupe,
and a short honest empty answer. No runtime evidence is committed here.

| Time | Skill / output | Owning agent |
| --- | --- | --- |
| 02:00 daily | [release-nightly](release-nightly.md): workflow decides no-op / stores / OTA | Speedy, release-corner |
| 03:00 daily | [overnight-latency](overnight-latency.md): headless Chrome web interactions | Jellybean |
| 03:30 daily | [overnight-codebase-health](overnight-codebase-health.md): existing untangle-codebase + 14-day PR churn | firstmate_2 |
| 04:15 daily | [overnight-ci](overnight-ci.md): CI/bloat/flakes + offline prompt-case intake | firstmate_2 |
| 05:00 daily | [overnight-errors](overnight-errors.md): existing triage skill + current Sentry/feedback | Ruby |
| 05:30 Sunday | [prompt-weekly](prompt-weekly.md): one bounded failure-driven experiment, if justified | firstmate_2 |
| 09:00 daily | [morning-card](morning-card.md): release line + overnight tuples; one tap per fix | firstmate_2, existing owner-card destination |
| 14:00 daily | [insight-loss](insight-loss.md) + [insight-workspace-walk](insight-workspace-walk.md), and no other sources | firstmate_2, existing owner-card destination |

Each diagnostic hands its tuples to the card owner, who alone writes the ledger.
The errors loop calls `beeline-triage` / `feedback-triage-steps` unchanged; codebase
health calls the upstream `untangle-codebase` skill unchanged. Their assessment
scope ends at proposed fixes until the card is approved. Prompt experiments may
return `No demonstrated improvement.`; existing spend caps stay unchanged.

After merge firstmate saves each `<slug>.md` as a procedure of the same slug with
`remember(kind:procedure,action:save,slug,description,markdown)`, then updates
human-authorized schedules to load it with `read(facet:procedure,slug)` and run it.
The exact schedule/procedure cutover is listed in the PR body; no production
schedules or saved procedures are changed by this PR. Keep old generated
workflow runs until completed/cancelled, rather than orphaning their gates.

Retire velocity, Loops writer, the separate 07:00 triage, 19:00 value loop and
08:00 path-check/rival-scan wakes. Make X ads weekly, outside either card. Keep the
Android sign-in one-off until its own success condition deletes it. The legacy
prompt-nightly-replay schedule becomes the Sunday prompt-weekly schedule; no
nightly paid hill-climb remains.

Local checks (sequential): `node --test scripts/nightly-release.test.mjs`,
`node --import tsx --test scripts/loop-card.test.mjs`, then
`npm test -w @beeline/server -- --run src/insight-loss.test.ts --maxWorkers=2 --minWorkers=1`.
