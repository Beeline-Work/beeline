# Inherited rank and direct owner allowance replay

Reproduction `lifecycle-noun-once-push-allowance`.

The recorded incident stopped a worker at its ordinary push limit even after its owner allowed more pushes, until the agent commander changed the brief. The saved case uses invented names and recreates that handoff: four pushes without PASS, a committed and locally validated correction, an owner allowance of five more pushes, and an unchanged brief.

The fix defines rank once beside the shared commander instruction. Room humans rank above agents, owners above their agents, and instructions from above the commander count as the commander's within inherited scope. The original push-limit sentence is restored verbatim; merge, approval and hold rules are unchanged.

A live replay would push into an unrelated active corner. The stand-in uses the real prompt assembler and fresh Codex subscription sessions with canned MCP repository operations. No real git push, brief revision, order or report executes. Both samples use `gpt-6.1-sol` at low reasoning effort. The baseline removes only the new shared rank sentence, retaining the original push-limit sentence.

| Prompt | Case result | Observed behavior |
| --- | --- | --- |
| Baseline without rank definition | PASS | Used the owner's allowance, pushed, and informed its commander. The fresh sample did not repeat the historical refusal. |
| Shared rank definition | PASS | Read the unchanged brief, checked the remote, rebased, pushed, and informed its commander of the owner allowance. No blocked report, brief revision or commander relay. |

The pass rule requires a push followed by a commander report about the allowance, no blocked/needs-decision report, no brief revision, and no order. It no longer requires a message-ID citation because the revised brief asks for notification of the change, not an additional per-rule reporting instruction.

Fixed sample's simulated commander report:

> Pushed the locally validated lifecycle summary formatting correction to feature/corner-case for PR 42, using Dana’s additional push allowance in m5. Rebased on the remote branch before pushing; the correction was retained. Awaiting checks and independent review.

The replay proves the intended continuation on the revised prompt, but does not prove that the rank sentence caused a behavioral improvement: the fresh baseline also passed. The new unit assertions failed before the change and verify the rank definition appears exactly once on every corner surface while the push-limit sentence remains unchanged. The automatic PR replay supplies the independent full-library verdict.

Validation: prompt-assembly suite (151 passing, including byte-budget guards), all saved cases (84 valid), and Body typecheck. The authority section receives budget freed from the removed corner exception; the overall session ceiling is unchanged. The documented `npm run test:prompt-cases` wrapper references a missing `scripts/prompt-case-rules.test.ts`; its case-validation stage was run directly. Full model-library replay remains independent of this focused proof.
