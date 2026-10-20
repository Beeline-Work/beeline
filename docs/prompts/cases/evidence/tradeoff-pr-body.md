Agents can describe shipped work by request numbers and lose reporting limits when dispatching it. Add a user-benefit wording rule and an eleven-word reporting instruction to the existing brief-writing skill. Speedy's independent rerun supplies the reference figures: main 70/77 scenarios (208/231 samples), round nine 73/77 (217/231), for thirteen additional always-loaded words per surface. The author's higher exact scores did not reproduce; the direction and word counts did.

| Run | Main scenarios; samples | Round nine scenarios; samples |
| --- | --- | --- |
| Speedy, independent reference | 70/77; 208/231 | 73/77; 217/231 |
| Jellybean, optimization history | 71/77; 209/231 | 75/77; 220/231 |

The ten-round table, individual A/B/C comparisons, paired-memory grading, model-identity audit and raw samples are in `docs/prompts/cases/evidence/tradeoff-loop.md`. All twelve memory cases and harness changes from #2645 are included. Of five redacted long-context candidates, only shipped-status failed main admission and entered the library. The final removal candidate was dropped at the ten-round cap. No prompt sentence is deleted in the selection.

## Reproduced

Not a defect report. Reproduction tradeoff-loop is the agreed stand-in: export assembled prompts, replay fresh `claude-opus-5-5` sessions three times per scenario, and mechanically grade the whole suite. Frozen main source `9be1ae2b17609b5b3bf91ebe50371f2ff0e5792b` has the same prompt/tool/skill sources as integrated main `2f1166d976b75f1a7159d0befa2a23403a137977`. Speedy's independent baseline is the reference: 70/77 scenarios, 208/231 samples.

## Demonstrated

Reproduction tradeoff-loop independently improves to 73/77 scenarios and 217/231 samples on round nine, a gain of three scenario majorities. The author's selection run scored 75/77 and 220/231 versus 71/77 and 209/231; those exact figures were not reproduced. Word counts (main→selection): Room 789→802, DM 599→612, repository-author corner 1061→1074, repository-free corner 642→655. The skill adds eleven on-demand words with no description change.

The shipped-status matcher now accepts `Expired sessions now fail clearly at sign-in (PR #86).` and rejects work numbers outside parentheses. Regression tests also cover reference forms with and without PR/hash prefixes and preserve the prohibition on falsely shipping the animation. All 27 archived author/admission replies and all six fresh independent replies were regraded: no grades changed, and the independent reference totals remain unchanged. Matcher repairs apply equally to unchanged baseline and candidate replies; no new model calls were made.

Preparation, twelve rule/harness tests, 65-case validation and root typecheck pass. Prior prompt/skill validation passed 169 assembly/layering/skill tests and the dead-code baseline gate. The affected path is assembled prompt → fresh model → whole-suite grading; no model calls run in CI and no server or UI logic changes.

Rule 10 is a weakness on both main and head, not a reproduced regression. Credential-file and browser-guard failures are provider refusals, not prompt regressions; they remain counted failures. Three samples are noisy. Raw replies and exclusions remain auditable; off-model attempts are excluded by identity, while genuine requested-model refusals, malformed replies and timeouts remain failures.

Keep the hold. No approval or merge: landing requires lunchboxfortwo's explicit yes forwarded by Ruby, live green checks and approval on the exact head.
