# Overnight CI

Versioned procedure: `overnight-ci`.

## 1. Freshness gate

Read the live `/version` and newest published GitHub Release's `release.json` first.
Resolve the deployed SHA and deployment time for the affected component using
[the shared contract](contract.md#freshness). Pin that SHA for the run. Every
candidate must be reproduced on it or observed in events at/after its deployment;
drop evidence seen only on an older release. A later event from an older phone or
helper is still stale. Unknown versions require reproduction, not an assumption.
Recheck before delivery; on a release change revalidate against the new SHA.
Missing deployment evidence is **OPEN QUESTION**, never a clean bill of health.

## 2. Fixed questions

Use GitHub runs/jobs/artifacts and exact test output; record query windows.
Historical main runs locate suspects; a suspect on an unreleased commit is not
a current-release finding until reproduced on the pinned deployed checkout.

1. Which jobs failed at least twice on main in the last 24 hours, with the same
   failure signature? Is it product/test failure, infrastructure, or cancellation?
2. Which tests failed then passed on the same SHA with no code/config change?
   Does a bounded rerun on the deployed checkout reproduce the flake?
3. Which job dominates critical-path wall clock, and what is its runtime versus
   its seven-day median for comparable runs? Separate queue time from execution.
4. Which downloads, generated artifacts or bundles grew against that baseline?
   Which dependency/output accounts for the measured bytes or time?
5. Which tests exercise the same behavior without catching different failures?
   Prove duplicate coverage using the behavior/assertions; line similarity alone
   does not justify deletion. Name the unique regression protection retained.
6. Which new prompt failure cases validate offline against the current assembler
   (`node --import tsx scripts/prompt-cases.ts`)? No nightly prompt search. Only
   when new cases/drift justify it, run a fixed ten-case one-trial smoke on each
   of two deployed profiles within existing caps; label simulation evidence.
   Follow [prompt-weekly](prompt-weekly.md) for the weekly experiment.

Use at most two Vitest workers, one suite at a time. A rerun proves a flake only
with the same inputs. Never mute a check, delete unique coverage, or raise a
budget to make a finding disappear.

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
