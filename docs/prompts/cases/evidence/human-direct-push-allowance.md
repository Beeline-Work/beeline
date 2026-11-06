# Direct human push allowance replay

Reproduction `lifecycle-noun-once-push-allowance`.

The recorded incident stopped a worker at its ordinary push limit even after a human allowed more pushes, until the agent commander changed the brief. The saved case uses invented names and recreates that handoff: four pushes without PASS, a committed and locally validated correction, a human allowance of five more pushes, and an unchanged brief.

A live replay would push into an unrelated active corner. The stand-in uses the real prompt assembler and a fresh Codex subscription session with canned MCP repository operations; no real git push, brief revision, order or report executes. The baseline replaces only the changed push-limit sentence with its pre-fix text from commit `041d79530`. Both samples use `gpt-6.1-sol` at low reasoning effort.

| Prompt | Case result | Observed behavior |
| --- | --- | --- |
| Baseline | FAIL | Pushed using the human allowance, but did not report the change and human message ID to its commander. The fresh sample did not repeat the historical refusal. |
| Fixed | PASS | Read the brief, checked the remote, rebased, pushed, and reported the allowance with its message ID. No blocked report, brief revision or commander relay. |

The pass rule requires a push, a commander report or corner post citing `m5`, no blocked/needs-decision report, no brief revision, and no order.

Fixed sample's simulated commander report:

> Pushed the committed, locally validated lifecycle summary correction to feature/corner-case for existing PR 42 after rebasing on origin/feature/corner-case. The summary reads 3 PRs opened · 4 merged. Dana authorized five additional pushes in m5; used one. Awaiting checks and independent review.

The focused replay is behavioral evidence for this case, not a guarantee across models or a review of the patch. The automatic PR replay provides the independent full-library verdict.

Validation: prompt-assembly tests (150 passing, including the original byte-budget guard), all saved cases (84 valid), and Body typecheck. The documented `npm run test:prompt-cases` wrapper could not run its missing `scripts/prompt-case-rules.test.ts`; its case-validation stage was run directly. Earlier attempts found a broken first Codex executable and an unsupported `gpt-6` model; a working installed Codex executable with `gpt-6.1-sol` completed the samples above. Earlier Luna samples on preliminary fixtures missed the required commander citation.
