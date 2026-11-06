# Morning approval card

Versioned procedure: `morning-card`.

## 1. Freshness gate

Read the live `/version` and newest published GitHub Release's `release.json` first.
Resolve the deployed SHA and deployment time for the affected component using
[the shared contract](contract.md#freshness). Pin that SHA for the run. Every
candidate must be reproduced on it or observed in events at/after its deployment;
drop evidence seen only on an older release. A later event from an older phone or
helper is still stale. Unknown versions require reproduction, not an assumption.
Recheck before delivery; on a release change revalidate against the new SHA.
Missing deployment evidence is **OPEN QUESTION**, never a clean bill of health.

## 2. Fixed questions and card delivery

1. What is the 02:00 release's final outcome line and run link? Pending/failed
   is stated plainly; use no success language based on an intermediate job.
2. Have overnight CI, codebase health, errors and latency returned their current
   findings? An absent/failed loop is a coverage **OPEN QUESTION**, not nothing.
3. Which tuples are duplicate causes, stale, already reported or already in fix
   corners? Apply the shared ledger. Rank the rest by confirmed impact/severity
   using the existing triage verdicts, not a new scoring rubric.
4. Which at most three tuples fit one screen with the release line? Keep the
   rest unreported in the private backlog. Never silently discard a critical
   item; use it instead of a lower-impact tuple.
5. Does each concrete fix have one-tap approval and each uncertain fix visibly
   say **OPEN QUESTION**? Follow [card delivery](contract.md#cards) using
   `scripts/loop-card.mjs`; only actual approvals open fix corners.
6. On a weekly prompt experiment day, include its one eligible behavioral tuple
   (or "no demonstrated improvement") after the same freshness/dedupe gate.
   On the next card after installing these skills, first recheck the grader
   false-pass candidate in [prompt-weekly](prompt-weekly.md#first-candidate), then
   offer its truthfulness/authority fix. The research report alone is not proof
   of a current-release bug.

At 09:00 publish the release line plus at most three compact tuples and their
approval choices. On an approval wake, recheck release/ledger, open that tuple's
fix corner once with the approved spec and evidence references, record its address,
then continue the remaining choices. A skip, timeout or OPEN QUESTION opens none.
The tap approves the proposed fix work, not merging or releasing it.

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
