# Commander report refusal proof

Reproduction `report-commander-refused` covers a repair ordered by an agent,
followed by a replacement PR head and a report to that ordering agent.
Before the fix, every report status fails with
`409: commander could not receive report`. The report uses its commander's
incoming command as its parent, then mistakenly uses that parent's old review
head as the report's evidence. Wake creation rejects the superseded head.

The fix uses the reporting turn as the review evidence source and keeps the
existing parent for return routing. Repair reports have no verdict context;
current reviewer reports retain their own head. Stale reviewer verdicts still
cannot publish. Membership, order provenance, depth, and human delivery rules
are unchanged.

## Feedback evidence

Read through the owner's vaulted read-only Neon HTTP route on 2026-10-25.
The recent cohort contains ten feedback items from three distinct agents.
All return addresses are the same corner as the reporting turn. None of this
cohort is a Room order or saved workflow step. Private report text and identifying
Room/member details are omitted.

| Feedback item | Reporting command shape |
| --- | --- |
| `fb_4b07cbf68e75782b7bb9f2f9` | Agent repair order, inherited old review head |
| `fb_9828c628391275d0fed23d26` | Agent repair order, inherited old review head |
| `fb_c33ac663b1b78107fa012e8c` | Agent repair order, inherited old review head |
| `fb_df0230114a091dfb2da17833` | Reviewer subscription continuation, newer head than repair parent |
| `fb_bfb48aef3a4b09a47129e070` | Reviewer subscription continuation, newer head than repair parent |
| `fb_87008f3306de317ae0214b72` | Reviewer subscription continuation, newer head than repair parent |
| `fb_4058b2e6d7d0e309ec96540c` | Reviewer subscription continuation, newer head than repair parent |
| `fb_5a9d16f3f13823ad79bc2349` | Reviewer subscription continuation, newer head than repair parent |
| `fb_3382233ab54a8890bb127063` | Landing continuation without review context, old review parent |
| `fb_bdbb369d2ef0f65efb4ac761` | Agent-tag continuation corroborating a worker's refused repair report |

Eight items store the exact refusal in `error_excerpt`; the other two describe
the refusal in their summaries. Two subscription items share one request ID,
so feedback count is not a count of distinct failed command attempts.
Older matching items outside this recent cohort also exist. The earlier
waiting-state report exemption shipped in PR #2821; its regression passes and
does not resolve this review-context mismatch.

## Reproduced and demonstrated

The server integration fixture calls the actual `DaemonService` order, claim,
report, command read, and recipient claim operations against isolated PGlite.
It creates no production orders. A live production write would wake real agents,
so this is the closest isolated stand-in for the affected service path.

`commander-order-target.integration.test.ts` failed before the fix with the
exact refusal for done, blocked, failed, and needs-decision after a new head.
After the fix, those same paths deliver privately to the ordering agent, which
successfully claims the report wake. The report retains that agent's incoming
command as parent, never wakes the next commander, and creates no public report
message. A separate regression checks a current reviewer report over an older
repair parent, preserving the current verdict head. Old reviewer output remains
suppressed.

Run the regression with:

```sh
npm test -w @beeline/server -- src/commander-order-target.integration.test.ts
```

Built-service proof uses the same fixture with its database, daemon service,
phone service and live hub imports pointed at `../dist/` after
`npm run build -w @beeline/server`. The temporary fixture is removed afterward.
The human report/tray, order-loop, removed-member, waiting, and batched wake
regressions remain in `commander.integration.test.ts` and
`commander-wakes.integration.test.ts`.
