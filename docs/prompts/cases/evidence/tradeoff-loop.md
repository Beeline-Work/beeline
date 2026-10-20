# Prompt tradeoff loop

Selected variant: remove two redundant sentences, saving eight always-loaded words on every surface. Both main and the selection pass every case by three-sample majority. This is a modest size improvement, not an accuracy improvement. The sample rate slipped from (154/156) to (152/156); the independent rerun must assess that uncertainty before approval.

## Round table

Words are listed in Room / DM / code-corner / repository-free-corner order. Pass rate means cases passing by majority; sample rates are shown separately. Screens use one sample per case. Confirmation uses three total samples per case, including the screen sample.

| Round | Candidate | Words before → after | Whole-suite result | Decision |
| --- | --- | --- | --- | --- |
| 0 | Main, repaired fixtures and the new browser guard | 789 / 599 / 721 / 642 | 52/52 cases (100%); 154/156 samples (98.72%) | Baseline |
| 1 | Add A (user benefit wording), B (capability recovery), C (verify existing work) together | 789 / 599 / 721 / 642 → 837 / 647 / 769 / 690 | Screen 50/52 (96.15%) against baseline 52/52 | Dropped: no gain for 48 extra words |
| 2 | Remove “Never just restate the problem” and “Follow tool results” | 789 / 599 / 721 / 642 → 781 / 591 / 713 / 634 | Screen 51/52; confirmation 52/52 (100%); 152/156 samples (97.44%) | Provisional keep: equal case score, eight fewer words |
| 3 | From round 2, also remove two general style sentences and the duplicate Room silence sentence | 781 / 591 / 713 / 634 → 757 / 576 / 698 / 619 | Screen 52/52; partial confirmation loses handover majority (1/3), then controller interrupted | Dropped: did not confirm the screen; incomplete confirmation is not a keep |

Stopped after three candidate rounds. Tested additions did not improve the score, and the broader deletion did not preserve the handover majority during confirmation. No change was kept on a one-sample accuracy win. The deterministic word saving supports the provisional selection; a small sample-rate difference does not establish either accuracy gain or equivalence.

## Baseline and failures

Source main: `9be1ae2b17609b5b3bf91ebe50371f2ff0e5792b`, fetched at the start and again before delivery. Model: `claude-opus-5-5`. A separate CLI metadata check confirms that canonical model; its JSON is archived.

The original main library has 51 cases. Initial unrepaired fixtures failed handover and landing. The repaired main comparison has 52 cases, including the new redacted long-history browser guard. No case fails its three-sample majority. Individual baseline failures are handover and resume (each 2/3). The new guard passes on main (3/3), so it remains a guard and does not establish a main defect.

The selected variant's individual failures are Android emulator syntax, Room write refusal, browser recovery, and service connection (each 2/3). Three involve reply format: an emulator call with no `args` field and two invalid JSON replies; they remain failures. Round 1's screen failures are handover and the long-history browser guard. Round 2's screen failure is the guard, which passes its final majority (2/3).

PR #2645 remained open and unmerged at both dependency checks, at head `277f69e1864e9ecebb5f81d60914d7b6dc30f829`; its twelve memory cases are not part of this main baseline. If it merges before the independent comparison, include them in both baseline and final runs. These results do not measure the house rule against those additional cases.

## Case repairs applied equally

- Exact-handle and handover predicates named the removed `post_to_corner`; they now recognize `post`.
- The handover target was also the configured reviewer, whom the worker must not recruit. A different agent now reviews the case.
- The landing fixture supplied no gate facts or corner address. Its read stub now supplies a permitted gate and address, so safe refusals are not mistaken for prompt failures.
- The restart text matcher now recognizes an explicit statement that shell access is unavailable or the restart has not happened, including observed honest wording.

Changed-context handover and landing cases were replayed on main and each candidate. Matcher-only repairs grade the same recorded replies. Repairs are not credited as prompt gains. Original-fixture prompts and samples remain in the archive.

## Method and audit

Each sample starts a fresh Claude process with native tools disabled, strict MCP configuration, project settings disabled, and a fixed simulation system prompt. The controller supplies the exported replay prompt, returns only requested skill bodies, and concatenates calls and text over at most six rounds. Initial controllers use four workers; the final continuation uses ten. Independent screens overlapped, but keep decisions waited for baseline and confirmation. No CI job calls a model.

Words are whitespace-delimited tokens in the assembled session text for the fixed contexts in `measure-session-words.ts`, with Squire available. Turn-specific history and case setup are excluded. Run `node --import tsx docs/prompts/cases/evidence/measure-session-words.ts` from the checkout to reproduce the final counts. The archive includes the source for each candidate and the original measurement script.

`tradeoff-loop-samples.tar.gz` contains exported prompts, loadable skill bodies, normalized samples, raw successful responses, grade tables, model metadata, and the controller. `original-fixtures/` preserves superseded context samples. Extract it and grade with `npm run prompt-cases -- --grade <extracted>/baseline` or `--grade <extracted>/removal-candidate`. `round1/` holds the rejected additions screen; `round3/` holds the rejected broader deletion screen and partial confirmation.

Two malformed replies exposed a controller bug: it raised before saving full raw output. Their available error prefixes are preserved in diagnostic `.raw` records; the full replies are unavailable. The round-2 Room sample and round-3 GitHub sample are marked malformed and counted as failures, with no replacement. Later malformed output is saved before parsing and also counts as failure. Round 3 has missing samples after interruption and is not a complete confirmation. This evidence limitation is explicit so independent review does not mistake reconstructed diagnostics for full raw replies.

## Validation and decision

This is an optimization, not a defect report. The exact path is exported assembled prompts → fresh Claude replies → mechanical whole-suite grading. A live browser test does not exercise that path.

Preparation completed. Prompt case validation passes (52 cases, seven rule tests). Assembly, layering and skill tests pass (169 tests), with generated prompt examples refreshed. Root typecheck passes on the final variant. No server, runtime behavior or UI logic changed.

Ruby should order Speedy to independently rerun the final variant and baseline on Claude. Keep the human hold: merge requires lunchboxfortwo's explicit yes relayed by Ruby, along with the live check and head approval gate.
