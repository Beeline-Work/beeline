# Corner lifecycle emulator proof

Fresh captures from the rebased `fm/corner-ripout-program` build, taken on
2026-08-31 by the passing Android emulator smoke. These are the complete
new-flow records; no legacy landing or approval-flow capture is retained.

1. `corner-ripout-working.png` — parent Room shows the active corner bar.
2. `corner-ripout-opened.png` — opened corner, objective, and transcript.
3. `corner-ripout-idle-nudge.png` — one completion-ladder nudge for the
   pushed-without-PR rung.
4. `corner-ripout-pr-fact.png` — agent steer/reply and typed GitHub PR card
   with its `View on GitHub` link.
5. `corner-ripout-checks-red.png` — visible `agent checks failing` line.
6. `corner-ripout-gh-merge-command.png` — plain `SMOKE GH MERGE` command.
7. `corner-ripout-gh-merge.png` — child is archived/read-only after merge.
8. `corner-ripout-landed-summary.png` — parent Room's landed summary and PR
   URL.
9. `corner-ripout-corner-removed.png` — parent no longer has the active
   corner strip.
10. `corner-ripout-archived.png` — final parent-Room archived state.
11. `corner-ripout-worktree-cleaned.png` — parent fact confirms worktree
    cleanup after branch deletion.

The same run asserts render propagation without enlarging the existing test
budgets: Room send 132 ms, agent reply 92 ms, idle nudge 129 ms, corner steer
126 ms, corner reply 135 ms, PR fact 89 ms, landed summary 93 ms, and
worktree-cleaned fact 149 ms.
