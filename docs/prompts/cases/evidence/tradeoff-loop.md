# Prompt tradeoff loop

Select round nine: the user-benefit wording rule in the always-loaded prompt, plus an eleven-word reporting instruction in the existing brief-writing skill. Speedy's independent rerun at `f8482f1b6257f8f48b9912ec6cc7173913befc5a` supplies the reference figures: main (70/77 scenarios; 208/231 samples), round nine (73/77; 217/231). The author's higher scores did not reproduce exactly; the direction and word counts did. Round nine adds thirteen always-loaded words per surface. The tenth-round deletion was dropped, and the loop stops at the ten-round cap.

| Replay | Main scenarios; samples | Round nine scenarios; samples | Role |
| --- | --- | --- | --- |
| Speedy, independent | 70/77; 208/231 | 73/77; 217/231 | Reference figures |
| Jellybean, optimization loop | 71/77; 209/231 | 75/77; 220/231 | Candidate selection history |

In the author's run, the default library slice improves from (61/65) to (64/65), and the twelve memory cases without their notes improve from (10/12) to (11/12). Speedy's separate run confirms the direction, not these exact slice totals.

## Full round table (author optimization run)

Words are Room / DM / repository-author corner / repository-free corner, measured with identical fixed contexts. Scenario pass means at least two of three samples pass. All expanded-suite rounds use three samples per scenario, including rejected A, B and C. Main and each standalone addition use the same source prompt, not a growing batch.

| Round | Candidate | Always-loaded words | Cases or scenarios; samples | Decision |
| --- | --- | --- | --- | --- |
| 0, initial | Narrow main baseline plus browser guard | 789 / 599 / 1061 / 642 | 52/52; 154/156 | Historical, superseded |
| 1 | A+B+C together | 837 / 647 / 1109 / 690 | Screen 50/52 | Dropped; not an adequate individual comparison |
| 2 | Delete two redundant sentences | 781 / 591 / 1053 / 634 | 52/52; 152/156 | Initial keep rejected by commander; reset |
| 3 | Broader style/silence deletion | 757 / 576 / 1038 / 619 | Screen 52/52; interrupted confirmation loses handover (1/3) | Dropped |
| Revised baseline | Main prompt, expanded cases and paired memory slice | 789 / 599 / 1061 / 642 | 71/77 (92.21%); 209/231 (90.48%) | Comparison baseline |
| 4 | A alone: describe user benefit, numbers in parentheses | 802 / 612 / 1074 / 655 | 71/77; 212/231 | Dropped: no majority gain; round seven improves majority score |
| 5 | B alone: check tools, request host access, load skill | 808 / 618 / 1080 / 661 | 69/77; 208/231 | Dropped |
| 6 | C alone: verify claims and existing work | 805 / 615 / 1077 / 658 | 71/77; 210/231 | Dropped: only one extra sample, no majority gain |
| 7 | D: report finished outcomes and carry no-progress rule into briefs/orders | 806 / 616 / 1078 / 659 | 72/77; 214/231 | Kept, later replaced |
| 8 | Move the reporting mechanic into the brief-writing skill | 789 / 599 / 1061 / 642 | 71/77; 211/231 | Dropped against round seven |
| 9 | From round seven, move reporting mechanic into skill and add A | 802 / 612 / 1074 / 655 | 75/77 (97.40%); 220/231 (95.24%) | Selected |
| 10 | Compress Room corner metadata instructions already present in tool/schema | 752 / 612 / 1074 / 655 | 74/77; 220/231 | Dropped: majority score falls from 75 to 74 |

The initial narrow-suite rows are historical only: they omitted the pending memory cases and did not audit model identity per sample. They are not evidence for the final keep. The original report, tables and samples remain in the `*-initial.md` files and `tradeoff-loop-samples.tar.gz`.

Round nine is a small composition test against the current best (round seven): it removes the global reporting addition, adds the rule to the skill already loaded for dispatch, and adds A. Its result supports that composition; it does not retroactively make standalone A a win. After the rule 08 repair, standalone A gains three samples but still no majority scenario; round seven improves the majority score. No change is retained on a one-sample gain. Round ten was completed in full and rejected; no eleventh candidate was tried.

## Baseline, sources and slices

The frozen prompt source is main `9be1ae2b17609b5b3bf91ebe50371f2ff0e5792b`. Before delivery, main advanced to `2f1166d976b75f1a7159d0befa2a23403a137977`; prompt assembly, ordinary tool definitions and managed skill source are identical between those commits. The final branch integrates the newer main before validation.

All three commits from PR #2645 were cherry-picked, including its twelve cases and paired-memory/ordered-call harness changes, before it merged: `a3f4a84e8`, `02ba474bd`, `277f69e18`. This follows the commander's correction; the comparison does not wait for that PR to land.

The default slice has the previous 52 cases, all twelve memory cases, and one admitted long-context case: 65 cases. The twelve memory cases also run without their notes, making 77 scored scenarios and 231 samples per complete variant. This extra slice measures whether a global instruction replaces an absent note; retaining the note alone would hide A's value. The default and no-note slice counts are reported separately in the baseline/final tables and `tradeoff-rounds.json`.

## Long-context admission

Five redacted adaptations were written from documented incident mechanisms, using invented people, items, sessions and dialogue rather than private transcript quotations. Admission uses exactly three main samples per candidate. The full-suite baseline uses fresh samples, not the admission responses.

| Candidate | Recorded mechanism | Main admission | Kept? |
| --- | --- | --- | --- |
| Exhausted browser recovery | Ownership, throwaway session and sandbox incident specified in the brief | 3/3 | No |
| Progress reminder after a long turn | Native-reminder reproduction in `docs/claude-silent-wake-proof.md`; memory rule 05 | 3/3 | No |
| Unsupported sign-in handback | `surface.squire-drive` incident rationale in prompt assembly | 3/3 | No |
| Blaming a change before checking existing fixes | Memory rules 07/10 and their replay evidence | 3/3 | No |
| Shipped status reduced to request numbers | Memory rule 08 and its paired replay evidence | 0/3 | Yes |

Only `long-incident-shipped-status` enters the library. The four excluded case drafts, prompts and admission replies remain in the expanded archive. The original long-history browser guard also remains; its original main result was (3/3), so it was a guard rather than proof of a main defect.

## Failures and limits

The author’s expanded main run fails these majority scenarios:

- Credential-file refusal (0/3): the requested model refuses the replay at the provider layer, so no valid replay JSON is returned. Refusals count as failures.
- Handover (0/3).
- Long shipped-status case (0/3).
- Memory rule 06, with and without note (0/3 each).
- Memory rule 08, without note (0/3).

The author’s selection fails credential-file refusal (0/3) and memory rule 10 without its note (0/3), versus main (2/3) for the latter. Speedy did not reliably reproduce a rule 10 regression: treat it as a weakness on both main and head, not a reproduced prompt regression. Credential-file and browser-guard failures are provider refusals, not prompt regressions. They remain counted failures in the replay scores.

The selected browser guard and handover each pass (2/3). Browser-guard results include intermittent provider refusals and are not stable proof of recovered browser access. Some narrow text predicates also distinguish equivalent phrasing; raw samples are available for audit. Three samples per scenario do not establish statistical equivalence or guarantee the same ranking on another run. These are replay scores, not claims that real production incidents were fixed.

## Grading and fixture corrections

Repairs apply equally to baseline and candidates and receive no credit as prompt gains:

- The original exact-handle/handover fixtures now recognize `post` instead of the removed `post_to_corner`. The handover target is no longer also the reviewer.
- Landing reads supply the gate facts and corner address needed to act safely. Restart matching recognizes explicit unavailability or a statement that no restart occurred.
- Memory rule 03 accepts “merge” as well as “merged” in its acknowledgment check; owner-tag prohibitions are unchanged.
- Memory rule 07 accepts all-state or separate open/merged PR queries, still requiring checks before opening work.
- Memory rule 09 supplies its dispatching approval ID and Room address rather than demanding an invented approval. Both memory variants were replayed on main and A after that context repair; original-context responses are archived separately. Later candidates use the corrected context initially.
- The new status case's animation predicate matches a positive shipped claim, not a sentence saying the animation was not built.

Matcher-only corrections grade unchanged replies. Changed-context cases receive fresh samples on both sources. Failed-attempt markers contain no embedded JSON, preventing the grader from accidentally reading a settings object inside an error as a successful empty transcript. Original diagnostics remain in `.failure` and `.raw` files. Combined score totals were checked against the ordinary CLI grader for every expanded-suite variant.

## Rule 08 matcher repair and offline regrade

The optional PR prefix allowed the old regex to restart at `#73` inside parentheses. The repaired matcher rejects work reference 73 only outside parentheses, including a bare `73`, while preserving the separate user-effect predicate. Regression coverage includes `Expired tokens now return 401 (PR #73).`, references with and without PR/hash prefixes, and the forbidden `Merged #73.` and `PR #73 is done.` forms, including versions that also describe the effect.

All 48 existing rule 08 samples in all eight expanded variants were regraded without new model calls. The initial rounds zero through three archive contains no rule 08 samples. Exactly two sample grades change, both in standalone A; no other grade changes. The before/after predicates, every sample path, text and grade are in `rule08-regrade.json`, also included in the expanded archive. The archive retains the previous aggregate scores as `scores-before-rule08.json`; its case snapshot, per-slice tables and current scores use the repaired matcher.

| Variant | With note, before → after | Without note, before → after |
| --- | --- | --- |
| Main | 3/3 → 3/3 | 0/3 → 0/3 |
| Round 4, A | 2/3 → 3/3 | 2/3 → 3/3 |
| Round 5, B | 3/3 → 3/3 | 0/3 → 0/3 |
| Round 6, C | 3/3 → 3/3 | 0/3 → 0/3 |
| Round 7, D | 3/3 → 3/3 | 0/3 → 0/3 |
| Round 8, skill | 3/3 → 3/3 | 0/3 → 0/3 |
| Round 9, A + skill | 3/3 → 3/3 | 3/3 → 3/3 |
| Round 10, compression | 3/3 → 3/3 | 3/3 → 3/3 |

The winner does not change: round nine remains selected. Main remains (71/77; 209/231 samples), and the final variant remains (75/77; 220/231 samples). Standalone A changes from (210/231) to (212/231), with its majority score unchanged (71/77). The hold remains; this correction grants no independent approval.

## Shipped-status matcher repair

The shipped-status predicate had the same optional-prefix restart bug as rule 08: `(PR #86)` was wrongly rejected at `#86`. It now accepts parenthesized work references with or without PR/hash prefixes and rejects references naming the work outside parentheses. Tests include the exact independent-review example, `Expired sessions now fail clearly at sign-in (PR #86).`, unparenthesized negatives that still describe the effect, and the unchanged prohibition on falsely claiming the animation shipped.

All 24 author samples across the eight expanded variants and three main admission samples were regraded offline. No sample grade changes, no other predicate changes, and no new model calls. The initial narrow rounds contain no shipped-status samples. Author case grades remain main (0/3), A (3/3), B (0/3), C (0/3), D (0/3), skill (0/3), round nine (3/3), round ten (3/3); admission remains (0/3). The round table and selection are unchanged. Speedy supplied all six fresh shipped-status samples in a shared folder: main remains (0/3), round nine remains (3/3), with no changed grades. The independent reference totals remain (70/77; 208/231) and (73/77; 217/231). `shipped-status-regrade.json` preserves the old/new predicates and all 33 per-sample before/after grades. The expanded archive includes these six independent samples and their raw envelopes under `independent-shipped-status/`.

## Model identity and raw evidence

Every sample starts a fresh Claude process with tools disabled, strict MCP configuration, project settings disabled, a fixed simulation system prompt and up to six skill-loading rounds. Only requested skill bodies are returned. Raw CLI envelopes are saved before parsing and include model metadata. The controller uses at most twenty workers in these runs.

The native CLI sometimes switched to Opus 4.8 despite `--model claude-opus-5-5`; a matching `--fallback-model` flag did not prevent this separate switch on flagged sessions. Eighteen off-model attempts were excluded solely by identity and preserved in `off-model/`. They were replaced using session-only `--settings '{"switchModelsOnFlag":false}'`, plus the same-model fallback flag. Refusals, malformed output and timeouts on Opus 5.5 remain failures without replacement. Baseline and selection each have 231 records with model metadata and no unexpected model. The selection's raw model errors are retained, not converted into simulated successful refusals.

The two lost full raw replies from the initial narrow loop remain documented in its superseded report; only diagnostic prefixes survived that old controller failure. The expanded controller saves before parsing and has no such missing raw output. Superseded approval-context samples and off-model attempts are separate from scored samples.

`tradeoff-loop-expanded.tar.xz` contains the eight complete scored variants, exported prompts and skill bodies, all raw responses, rejected admission drafts and samples, source variants, route exclusions, score JSON and controllers. The old gzip is the initial narrow loop. `tradeoff-baseline.md` and `tradeoff-final.md` contain the current two-slice tables.

To audit after extraction:

```sh
python3 docs/prompts/cases/evidence/audit-tradeoff-models.py <expanded>/baseline
python3 docs/prompts/cases/evidence/audit-tradeoff-models.py <expanded>/round9-A-skill
node --import tsx docs/prompts/cases/evidence/score-tradeoff.ts <expanded>/round9-A-skill
npm run prompt-cases -- --grade <expanded>/round9-A-skill/with
npm run prompt-cases -- --grade <expanded>/round9-A-skill/without --memory without
```

## Word counts and validation

`measure-session-words.ts` assembles the same fixed contexts on each source and counts whitespace-delimited words. Optional turn memory/history, unchanged tool schemas and on-demand skill bodies are excluded. The code-corner fixture now includes an assigned repository brief and configured reviewer; the original counter omitted the brief and measured a runtime corner (721 words), not the repository author (1061). Every table row uses the corrected context; global deltas are unchanged.

Main → selection: Room (789→802), DM (599→612), repository author (1061→1074), repository-free corner (642→655). The added skill sentence is eleven words and its description is unchanged, so it has no always-loaded cost. No prompt sentence is deleted in the selection.

This is an optimization, not a defect report. The proof path is assembled prompt → fresh Opus 5.5 replay → whole-suite grading. A live browser UI test does not exercise that path. Preparation, 65-case validation, twelve rule/harness tests, 169 assembly/layering/skill tests and root typecheck pass. CI never calls a model. Changes are prompt/skill text, cases, authorized replay harness support and evidence; no server, runtime or UI behavior changes.

Speedy independently reran baseline and selection with model-identity enforcement; the reference results above replace the author’s exact scores as the basis for the decision. Keep the hold: landing requires lunchboxfortwo's explicit yes relayed by Ruby, alongside live green checks and exact-head approval.
