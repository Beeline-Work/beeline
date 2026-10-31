# Answered blocker delivery reproduction

Verdict: reproduced on current main (`968c0de3c7210554cf108b385b4395fc9beae5bb`), using a recovered production report's delivery path. This satisfies the brief's reproduction-and-fix alternative; it does not claim that every historical report has the same cause.

## Production trace

Read on October 31 through Trusty Squire `use_credential`, using the owner's `neon` / `beeline-prod-db` credential, the Neon SQL HTTP endpoint and `Neon-Read-Only: true`. Only SELECT statements were issued. Private message text is omitted here.

| Evidence | Identifier or time (UTC, October 31) |
| --- | --- |
| Feedback item | `fb_0fd0fc28da34b3f6dd4e0107` |
| Report command / feedback request | `85227ba94f5e7630fe0ec93abe880724d730e50c1af34f78d882ecba4679abcf` |
| Origin corner | `6015d67b-d3c0-4d83-a280-b64011b6c977` |
| Return DM | `79efa989-fecd-4276-8ff3-ece8e2cf5a36` |
| Report created | `03:57:00.901493` |
| Commander reply in return DM | `67bbed7d95516fa31d8f15d1a9e49a5b5893b847f20524ce382ffcd360756ecc`, `04:03:52.527216` |
| Commander resolved outcome in return DM | `c7f3d752ec31f8a51d6108db3a2664ef750115adff6b3698d4620ae96f55f25e`, `04:04:26.424808` (done prefix) |
| Old report claimed | `04:12:28.575183` |
| Feedback recorded | `04:12:47.946371` |
| Old report completed | `04:12:49.791717` |
| Persisted report payload marker | `waitingAnswered: true` |

The report was a blocked status. `clear_corner_report_blockers` marks its private command answered when the commander posts in its return DM. That happened before the old report's eventual claim. On current main, delivery and claim ignore that marker: a report already settled in the attention index still authorizes another turn. This is a stale queued delivery, rather than evidence that a completed command was reopened.

## Reproduction STALE-ANSWERED-REPORT

Use synthetic text and an isolated PGlite database with migrated production schema. The real production daemon, orders and lifecycle are never exercised.

1. A human DM starts a commander turn; the commander opens a non-repository corner and its worker claims the assignment.
2. The worker sends a private blocked report while publishing is unfinished. Cache the command snapshot returned for the commander.
3. The commander posts a resolved outcome in the return DM. Verify the database trigger sets `waitingAnswered` on the report.
4. Attempt the cached claim, then read the command inbox.

Before the fix, both integration assertions fail: the cached claim succeeds and the inbox contains the answered report. The built baseline HTTP service independently returned HTTP 200 for the cached claim and delivered the report again.

After the fix, the same HTTP path returns HTTP 409 and the report is absent from the inbox. The persisted cancellation reason is `answered_report`. Pending batch sources and already released digest sources use the same fence; removing an answered source preserves other work. An already executing report keeps its live lease; after that lease expires, the answered report cannot be reclaimed.

```sh
npm run build -w @beeline/server
node --import tsx scripts/prove-answered-report.mjs
npm test -w @beeline/server -- src/commander-wakes.integration.test.ts src/wake-inbox.integration.test.ts src/corner-attention.integration.test.ts --maxWorkers=2 --minWorkers=1
npm run typecheck
```

To demonstrate the old HTTP behavior, build the baseline server and run the same proof with `--base`. That flag asserts the old bug and restores a synthetic pending row after its successful claim solely to observe the baseline inbox behavior as well.

## Boundaries

The fix trusts the existing server-owned answered marker; it does not infer completion from message wording, cancel arbitrary older orders, or interrupt active work. No production mutation or release was performed. The production event itself was not replayed against production: the narrow stand-in exercises its worker-report → commander-answer → delivery/claim path through a built local HTTP service.
