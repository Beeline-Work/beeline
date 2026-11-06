# Insight: workspace walk

Versioned procedure: `insight-workspace-walk`.

## 1. Freshness gate

Read the live `/version` and newest published GitHub Release's `release.json` first.
Resolve the deployed SHA and deployment time for the affected component using
[the shared contract](contract.md#freshness). Pin that SHA for the run. Every
candidate must be reproduced on it or observed in events at/after its deployment;
drop evidence seen only on an older release. A later event from an older phone or
helper is still stale. Unknown versions require reproduction, not an assumption.
Recheck before delivery; on a release change revalidate against the new SHA.
Missing deployment evidence is **OPEN QUESTION**, never a clean bill of health.

## 2. Fixed questions and sample

Use [workspace-sample.sql](workspace-sample.sql) through the owner's existing
vaulted **read-only** SQL route. It samples five distinct random workspaces with
human message activity in the last 24 hours, honors `allow_fix_sweep`, excludes internal workspaces and
any workspace containing `lunchboxfortwo` or `methoxine` in active membership
(including Room membership). Query once; never redraw to find a better story.
Record eligible count, sample IDs and window privately. If fewer than five are
eligible, inspect all returned; if zero, report exactly `0 eligible active workspaces.`
For sampled workspaces read only current-release context within the last 24h,
using the authorized triage/workspace read route; no corpus-wide model sweep.

For each workspace ask, in this fixed order:
1. What specific thing did its people try to accomplish? Separate their words
   from inferred goals; do not turn an inference into intent evidence.
2. Where did progress stall, repeat or stop? Was there a refusal, failure,
   unanswered question, or departure after friction? Silence alone is not churn.
3. Where did they obtain something useful, and what behavior/result demonstrates
   value? No praise or invented retention claim from a single session.
4. Is the cause current, reproduced and fixable? What one change would unblock
   the intent or preserve the observed value? Unknown causes are **OPEN QUESTION**.

Keep per-workspace observations private. Output only supported problem → fix
(or **OPEN QUESTION**) tuples; successful use without a problem is not filler.
At 14:00 the card owner combines this result with one run of
[insight-loss](insight-loss.md), reusing that result if already collected, applies ledger dedupe, and uses the card delivery procedure
in [contract.md](contract.md#cards). No velocity, rival scan or ads metrics enter
this card. An honest zero must remain visible even if insight-loss found tuples.

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
