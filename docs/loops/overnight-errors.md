# Overnight errors

Versioned procedure: `overnight-errors`.

## 1. Freshness gate

Read the live `/version` and newest published GitHub Release's `release.json` first.
Resolve the deployed SHA and deployment time for the affected component using
[the shared contract](contract.md#freshness). Pin that SHA for the run. Every
candidate must be reproduced on it or observed in events at/after its deployment;
drop evidence seen only on an older release. A later event from an older phone or
helper is still stale. Unknown versions require reproduction, not an assumption.
Recheck before delivery; on a release change revalidate against the new SHA.
Missing deployment evidence is **OPEN QUESTION**, never a clean bill of health.

## 2. Fixed questions and required skill

**Call the existing `beeline-triage` skill / `feedback-triage-steps` procedure
for severity and critical-versus-noncritical decisions.** Load it with
`read(facet:procedure, slug:"feedback-triage-steps")`; its repository source is
[feedback-triage-steps](../workflows/feedback-triage-steps.md). Apply its assessment
steps to the freshness-filtered candidates. Do not invent severity thresholds,
fork the skill, delete it, or start its old 07:00 scheduled workflow. This wrapper
collects its verdicts for the 09:00 approval card; its legacy direct-fix and
presentation instructions do not authorize work before that approval.

1. Which Sentry issues have events tagged with the currently deployed release?
   Rank by distinct users affected on that release, then current event count;
   lifetime issue counts and last-seen dates alone are insufficient.
2. Which human reports (`@system`, Report issue) and repeated agent feedback
   have current app/helper versions or a fresh reproduction? Read the original
   context privately through the existing vaulted read-only triage route.
3. Which release-failure issues still reproduce against current main/deployed
   release inputs? Close no issue merely because another workflow succeeded.
4. Which previously shipped fixes have failed again with current-version
   evidence? Which have inadequate traffic/coverage to judge?
5. What does the existing triage skill classify as critical, hold or drop, and
   which exact cause and minimal fix does current evidence support?

Retain feedback item IDs/signatures in tuples for later resolution. Never quote
customer transcripts or identities in the card, repository, issue or fix brief.
No separate 07:00 triage wake remains; the existing triage skill remains intact.

## 3. Problem → fix output

Use the [tuple contract](contract.md#tuples): stable key, evidence link and observed
SHA/time, concrete consequence, concrete fix, confidence. Mark an uncertain cause
or fix **OPEN QUESTION** and name the observation needed to settle it; never guess.
Output tuples only, without summaries, generic commentary or filler. Do not open
fix corners or make changes before the morning/insight card's explicit approval.

## 4. Dedupe and handoff

Read the shared [reported-tuples ledger](contract.md#ledger) before reporting.
Suppress the same problem even across loops or releases, unless a measured impact
worsened or its fix shipped and failed on the current release. Cite that delta.
Send eligible tuples to the card owner; do not mark an unpresented tuple reported.
The card owner is the sole ledger writer and records the actual card/answer/corner.

## 5. Empty result

`Nothing found.` is a complete successful result after all required reads/checks
succeeded. Missing access, failed capture or incomplete coverage is an
**OPEN QUESTION** tuple about that precise gap, never invented product findings.
