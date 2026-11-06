# Inherited rank and direct owner allowance replay

Reproduction `lifecycle-noun-once-push-allowance`.

The recorded incident stopped a worker at its ordinary push limit even after its owner allowed more pushes, until the agent commander changed the brief. The saved case uses invented names and recreates that handoff: four pushes without PASS, a committed and locally validated correction, an owner allowance of five more pushes, and an unchanged brief.

The fix defines rank once beside the shared commander instruction. Humans rank above every agent; instructions from above the commander count as theirs within inherited scope, and the worker reports what changed. There is no separate owner clause. The original push-limit sentence is restored verbatim; merge, approval and hold rules are unchanged.

A live replay would push into an unrelated active corner. The stand-in uses the real prompt assembler and fresh Codex subscription sessions with canned MCP repository operations. No real git push, brief revision, order or report executes. Both samples use `gpt-6.1-sol` at low reasoning effort. The baseline removes only the new shared rank sentence, retaining the original push-limit sentence.

| Prompt | Case result | Observed behavior |
| --- | --- | --- |
| Baseline without rank definition | FAIL | Used the human allowance and pushed, but omitted its commander report. The fresh sample did not repeat the historical refusal. |
| Shared rank definition | PASS | Read the unchanged brief, checked the remote, rebased, pushed, and informed its commander of the owner allowance. No blocked report, brief revision or commander relay. |

The pass rule requires a push followed by a commander report about the allowance, no blocked/needs-decision report, no brief revision, and no order. It no longer requires a message-ID citation because the revised brief asks for notification of the change, not an additional per-rule reporting instruction.

Fixed sample's simulated commander report:

> Dana directly authorized additional pushes in m5. Rebased on origin/feature/corner-case and pushed the locally validated formatting correction to the existing PR (42). The summary reads 3 PRs opened · 4 merged. Awaiting checks and independent review; no merge, hold or approval changes.

The latest paired replay fails without the shared sentence and passes with it on commander notification. Earlier baseline samples also passed, so this is not a claim of deterministic model behavior or a fresh reproduction of the historical refusal. Simplified rank-only samples omitted commander notification; the final shared sentence includes reporting the change, as the user story requires. The new unit assertions failed before the change and verify the rank definition appears exactly once on every corner surface while the push-limit sentence remains unchanged. The automatic PR replay supplies the independent full-library verdict.

Validation after integrating main: prompt-assembly suite (147 passing, including byte-budget guards), all saved cases (83 valid), and Body typecheck. The authority section receives budget freed from the removed corner exception; the overall session ceiling is unchanged. The documented `npm run test:prompt-cases` wrapper references a missing `scripts/prompt-case-rules.test.ts`; its case-validation stage was run directly. Full model-library replay remains independent of this focused proof.

After integrating current main, the rank sentence was shortened to fit the unchanged session ceiling. The fresh replay of that exact prompt passed: the worker read the unchanged brief, checked the remote, rebased, pushed, and reported Dana’s allowance to Juniper with four pushes remaining. No brief edit or blocked report occurred. Removed Android snapshot variants stay removed; remaining snapshots were regenerated from current contracts.
