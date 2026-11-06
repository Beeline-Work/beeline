# Overnight codebase health

Versioned procedure: `overnight-codebase-health`.

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

**Call the existing `untangle-codebase` skill as the method**, from
[its authoritative SKILL.md](https://github.com/caldoai/skills/blob/main/skills/untangle-codebase/SKILL.md).
Read it in full; do not fork, rewrite or replace it here. Invoke with this scope:
assessment and concrete proposals only, grounded in the deployed checkout and
last 14 days of merged PR churn; implementation waits for the daily approval.
No optional comment/test cleanup has been authorized by a scheduled assessment.
Keep any method scratch/decision log private; only tuples leave the loop.

1. Which files and symbol groups did merged PRs touch most in the last 14 days?
   Fetch merged PRs with `mergedAt`, merge SHA and changed-file lists (paginate),
   then use git diffs at those merge SHAs for co-change and added/deleted lines.
   Count each PR once; exclude generated/vendor files. Do not substitute open
   work or commit count for merged-PR evidence.
2. In those hotspots, which special cases and hidden dependencies repeatedly
   force edits elsewhere? Which recent PR links demonstrate that cost?
3. Which pieces change together but are separated, and which coupled pieces
   change for independent reasons? Use the skill's own assessment method.
4. Which one structural fix removes several demonstrated causes of churn while
   preserving behavior? What regression would disprove it?
5. Does the issue still exist at the deployed SHA? Is high churn simply active
   feature work rather than a structural fault? If the evidence cannot separate
   them, mark **OPEN QUESTION** instead of proposing a cosmetic refactor.

This owns the former velocity loop's useful question: where development effort
is going. Do not produce CI-wait-time dashboards or a separate velocity report.

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
