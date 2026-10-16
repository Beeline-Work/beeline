# Beebee stopped-restart and boot-session experiment

2026-10-16. The candidate does **not** demonstrate the required first-reply speedup or resume non-regression. Keep it unmerged pending a revised approach. This is a performance experiment, not a defect report.

The baseline tables and startup phases were posted in the corner before changing runtime code. Both sets use three real Fly Machines, real Pi, and the same server-pinned model. The disposable server/database run locally through a Cloudflare tunnel; Fly and model calls use Squire egress. These network hops, Fly host/image preparation, and upstream response variance qualify comparisons. No production Beebee Machine was changed.

|Build|Helper source|Image digest|
|---|---|---|
|Baseline|`1aed7b4235d4a61bca85975c1d08cab13edfaa02`|`sha256:297fb303996ea83020f7003ded2915f571c76d6268a84586ecbc73a3cf834854`|
|Candidate|`494384e601ac605f152e868d9accfc653cee870c`|`sha256:f8095a872ae79d6668be9b85e224488f1d2b31b158c07c3885645b6604c0162c`|

The later host-runner changes add the two-Room proof and tests; they do not change the measured helper. Temporary image tags expire after 24 hours.

## Per-step medians

Cumulative seconds from committed mention. Each cell is baseline → candidate. A dash means retained or absent, never zero. Milestones and API responses can overlap, so do not sum these columns.

|Path|Wake|Fly accepted|Machine started|Helper connected|Command claimed|Session ready|Model request|First byte|Reply|
|---|---|---|---|---|---|---|---|---|---|
|first-boot|0.019 → 0.020|0.969 → 1.389|6.011 → 13.373|8.360 → 15.974|8.423 → 15.970|14.171 → 22.044|14.667 → 22.773|15.326 → 27.944|15.599 → 29.472|
|stopped-restart|0.020 → 0.020|1.543 → 1.612|1.377 → 1.417|4.102 → 4.010|4.118 → 4.257|10.548 → 10.339|11.147 → 11.208|11.844 → 13.228|12.061 → 13.353|
|resume|0.037 → 0.022|0.870 → 0.739|0.698 → 0.456|— → —|0.796 → 0.837|— → —|1.769 → 1.999|2.621 → 3.540|3.072 → 3.656|

## Samples

Cumulative seconds, same milestones.

|Build/path/run|Wake|Fly accepted|Machine started|Connected|Claimed|Session ready|Model request|First byte|Reply|
|---|---|---|---|---|---|---|---|---|---|
|Baseline/first-boot/1|0.022|2.335|20.810|23.782|23.668|29.878|30.412|31.407|31.638|
|Baseline/resume/1|0.037|0.956|0.698|—|0.796|—|1.766|2.621|3.082|
|Baseline/stopped-restart/1|0.020|1.312|1.181|3.974|3.909|10.548|11.147|11.844|12.039|
|Baseline/first-boot/2|0.013|0.969|6.011|8.360|8.423|14.171|14.667|15.326|15.599|
|Baseline/resume/2|0.065|0.556|0.487|—|0.887|—|1.892|2.739|2.850|
|Baseline/stopped-restart/2|0.021|1.543|1.377|4.102|4.118|9.839|10.338|11.442|12.061|
|Baseline/first-boot/3|0.019|0.838|2.631|5.296|5.381|11.581|12.132|13.754|14.424|
|Baseline/resume/3|0.025|0.870|0.706|—|0.780|—|1.769|2.380|3.072|
|Baseline/stopped-restart/3|0.018|1.649|1.470|4.210|4.343|11.011|11.607|12.472|13.258|
|Candidate/first-boot/1|0.024|1.389|27.508|30.394|30.418|36.879|37.848|38.652|38.747|
|Candidate/resume/1|0.025|1.097|0.925|—|1.603|—|2.743|3.540|3.656|
|Candidate/stopped-restart/1|0.020|1.767|1.564|4.234|4.257|11.386|12.499|13.228|13.353|
|Candidate/first-boot/2|0.020|1.414|11.931|14.679|14.790|21.289|22.148|27.106|28.107|
|Candidate/resume/2|0.021|0.739|0.456|—|0.837|—|1.999|7.073|8.082|
|Candidate/stopped-restart/2|0.019|1.612|1.417|4.010|4.335|10.339|11.208|18.141|18.305|
|Candidate/first-boot/3|0.013|0.926|13.373|15.974|15.970|22.044|22.773|27.944|29.472|
|Candidate/resume/3|0.022|0.584|0.322|—|0.364|—|1.445|2.482|2.916|
|Candidate/stopped-restart/3|0.031|1.529|1.371|3.825|4.057|9.460|10.221|10.986|11.259|

## Session setup sub-steps

Monotonic seconds inside the helper. Configuration includes checkout refresh and concurrent configuration, roster, repository and grant reads. MCP bridge includes state-directory setup and native-MCP probing. Session new includes Pi startup and tool discovery. These are phase boundaries, not individual function attribution.

|Build/path/run|Configuration|Home|Assets|Toolchain|MCP bridge|ACP initialize|Prompt|Session new|Model selection|
|---|---|---|---|---|---|---|---|---|---|
|Baseline/first-boot/1|0.365|0.029|0.008|0.019|1.255|0.579|0.007|3.531|0.013|
|Baseline/stopped-restart/1|0.411|0.026|0.007|0.016|1.260|0.622|0.013|3.962|0.018|
|Baseline/first-boot/2|0.405|0.032|0.013|0.024|1.272|0.502|0.007|3.087|0.011|
|Baseline/stopped-restart/2|0.334|0.025|0.009|0.014|1.264|0.535|0.006|3.013|0.014|
|Baseline/first-boot/3|0.463|0.041|0.014|0.018|1.251|0.549|0.011|3.585|0.021|
|Baseline/stopped-restart/3|0.446|0.363|0.013|0.018|1.304|0.560|0.013|3.527|0.016|
|Candidate/first-boot/1|0.526|0.030|0.012|0.017|1.289|0.691|0.012|4.070|0.014|
|Candidate/stopped-restart/1|0.616|0.037|0.008|0.018|1.281|0.603|0.008|4.713|0.030|
|Candidate/first-boot/2|0.769|0.026|0.008|0.019|1.276|0.572|0.016|3.965|0.012|
|Candidate/stopped-restart/2|0.565|0.040|0.008|0.023|1.257|0.609|0.008|3.694|0.014|
|Candidate/first-boot/3|0.651|0.029|0.012|0.020|1.269|0.571|0.012|3.616|0.010|
|Candidate/stopped-restart/3|0.512|0.026|0.024|0.015|1.261|0.524|0.008|3.160|0.015|

## What overlapped

Bootstrap provides the pending Room before its command is claimed. The candidate starts only that first pending top-level Room through the existing scheduler while intake connects. Room-specific home, MCP bindings, permissions and session identity remain scoped to that Room. Conversation and institutional context are still obtained under the claimed turn. No preparation prompt calls a model. A failed preparation discards its client; the real turn retries normally.

first-boot: median claim → ready 6.200 → 6.461 s; preparation began 0.199, 0.163, 0.117 s before claim.

stopped-restart: median claim → ready 6.639 → 6.004 s; preparation began 0.185, 0.212, 0.143 s before claim.

The trace rejects the original expectation of hiding most of 4–6 seconds: preparation starts only 0.117–0.212 seconds before claim. Fresh retained-session configuration validation also costs a round trip before reuse. The first-boot reply median rose from 15.599 to 29.472 s; stopped-restart rose from 12.061 to 13.353 s; resume rose from 3.072 to 3.656 s. Model first-byte waits reached 5–7 seconds in several candidate samples, and image preparation varied substantially. This does not establish that the code caused those regressions; it does establish that the required user-visible improvement and resume non-regression were not demonstrated.

Next step: retain the current startup order and investigate the measured Pi session-new phase (roughly 3–5 seconds) before choosing another optimization. Do not change model, limits, Machine size, image contents or the protected System-message file to explain away this result.

## Reproduction and demonstration

Not a defect report. The timing path is create Workspace → mention Beebee → first reply; wait for suspend → mention → reply; wait for suspend → explicit stop → verify stopped → mention → reply. All nine samples completed for each build. The optional context check initially rejected an invalid mixed-case fixture Room name after timing had finished; the isolated context-only rerun uses a valid slug and preserves the fixed timing sample set.

The regression drives prepared sessions for two Rooms, asserts each prompt contains its own Room context and no foreign Room context, checks one session is reused and no prompt precedes command availability, and verifies failed preparation retries cleanly. Deliberately fetching another Room or supplying empty context makes the context test fail. Focused session, startup, scheduler and model-validation tests: 59 passed. Timeline summary: 2 passed. Root typecheck passed.


The real-Fly context-only rerun passed. Room B (`33405d38-647f-4607-97b9-4170e3a246d3`)
answered its own earlier code `7841edf5c0d72bd8` after a stopped boot; Room A
(`b3048860-6e0c-498d-a852-9b9c87cd52f0`) then answered its distinct earlier code
`b294abb9f28aa45f`. Neither question contained the code. These are disposable
fixture values, not credentials.

All seven test Machines and seven test Workspaces were deleted, including the
context-only rerun. Final Fly inventory contained only production Beebee
`857614db620078`, still suspended. Both proof egress grants were revoked; the
initially selected replacement grants were also revoked. Production Beebee was
never started, stopped, updated or otherwise mutated.

Evidence run IDs: baseline `1792187199071`, candidate `1792187901620`, separate
context proof `1792188485630`. The candidate runner's nonzero exit reflects the
invalid Room-name fixture after all nine timing samples completed, not a failed
timing sample. The context-only retry completed successfully. The sample tables
above intentionally exclude that extra first boot. Fly's suspended-state waits
occasionally completed late or returned 408/409; the harness separately verified
the actual state before each mention or stop. Retries of Fly start HTTP 412 remain
visible in the samples. Do not treat API response timing as sequential guest
execution timing.
