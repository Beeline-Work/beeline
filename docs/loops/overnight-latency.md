# Overnight latency

Versioned procedure: `overnight-latency`.

## 1. Freshness gate

Read the live `/version` and newest published GitHub Release's `release.json` first.
Resolve the deployed SHA and deployment time for the affected component using
[the shared contract](contract.md#freshness). Pin that SHA for the run. Every
candidate must be reproduced on it or observed in events at/after its deployment;
drop evidence seen only on an older release. A later event from an older phone or
helper is still stale. Unknown versions require reproduction, not an assumption.
Recheck before delivery; on a release change revalidate against the new SHA.
Missing deployment evidence is **OPEN QUESTION**, never a clean bill of health.

## 2. Fixed questions and measurement

Use the **web build in headless Chrome**, never the Android emulator, ADB,
device rig setup, or a cached emulator capture. Read the defined interactions
in `scripts/latency-rig/interactions.json` and routes in
`scripts/latency-rig/routes.json`; these are the inventory, not proof. Build/serve
the web app from the deployed SHA with the existing web toolchain. Verify its
source identity and authenticated fixture before capture. Use Chrome performance
marks/traces from input to visible committed response; network timing alone is
not interaction latency. Record browser version, fixture, cold/warm state and
sample count privately. Use an isolated review workspace for any writes.

1. Which defined taps exceed **150 ms**, and which loads exceed **450 ms**?
   Collect at least 20 samples per applicable scenario and report p50/p95;
   p95 at or above the budget fails. Explicitly enumerate unmeasured scenarios.
2. Does a second comparable capture reproduce each breach on the current build?
   Is it JS/render time, a server query, network delay, or missing response?
3. Which interaction fails to complete at all, and what trace pins its boundary?
4. What smallest change addresses the measured blocking work, and which before/
   after capture on identical fixtures will prove the user-visible improvement?
5. Is an unavailable native-only interaction outside this web measurement?
   Name that coverage gap; never claim the web capture proves native performance.

Return actionable breach → fix tuples, not latency tables. Failed browser setup,
login or capture is an explicit **OPEN QUESTION** about measurement coverage.

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
