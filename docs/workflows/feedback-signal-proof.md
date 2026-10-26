# Feedback signal verification

This is a workflow feature, not a defect report.

## Production replay

The 20 October 2026 pull handoff recorded 229 new items: 225 agent reports and
four human reports. A UTC-calendar-day query returns a different cohort (191),
so the replay uses the actual pull cutoff, 2026-10-20T14:00:51.919491Z.
The read-only production query reconstructs that cohort:

```sql
SELECT id, source_kind, category, summary, tool_name, error_excerpt, created_at,
       last_occurrence_at, occurrence_count, reporter_identity_id, occurrences
FROM feedback_items
WHERE created_at <= '2026-10-20T14:00:51.919491Z'
  AND (source_kind = 'human' OR created_at > '2026-10-19T14:00:51.919491Z')
  AND (status = 'new' OR triaged_at > '2026-10-20T14:00:51.919491Z')
ORDER BY created_at;
```

Only occurrences at or before the cutoff contribute to the replay count and
last-seen timestamp. Using groupFeedback from scripts/feedback-signals.mjs:

| Result | Rows |
| --- | ---: |
| Input | 229 |
| Stable groups | 224 |
| Agent groups | 220 |
| Human groups | 4 |
| Eligible groups (human impact or repeat) | 9 |

The normalization is conservative: changing URLs and generated IDs collapse;
HTTP status codes, tool and category remain distinct. Semantic assessment can
attach a human report to an agent group only after tracing the same cause.
An agent owner's identity does not establish human impact. No report content
or raw workspace text is stored in this repository.

## Demonstrated locally

The workflow integration test starts the saved workspace-walk through
startWorkflow, reserves more than five active workspaces, reads every SQL page,
refuses missing and zero-row receipts, then advances to done with valid receipts.
Existing service-review tests cover opt-out and page exhaustion. Contract
validation checks both saved workflows. Grouping tests cover stable signatures,
ranking, occurrence timestamps, eligibility and release observation windows.

Commands: npm run test:feedback-signals; server Vitest suites
feedback-triage-workflow.test.ts, identity-live.e2e.test.ts and workflow-runs.test.ts;
root npm run typecheck.

## Remaining live verification

The real 06:00 America/New_York walk requires this server version deployed.
After deployment, save the approved workflow definitions and procedures into
the operating Workspace (custom saved copies are deliberately not overwritten
by server seed migration), verify the 06:00/10:00 schedules, then collect one
real walk's private receipts. The PR's local proof does not claim that a future
scheduled walk has happened.

## Author attribution and Monday history

The existing 06:00 America/New_York walk uses a fourteen-day lookback on Monday;
other days retain incremental coverage. Monday keeps any older unread backlog.
SQL pages attach `authorId`, `authorKind` and agent `ownerId` to message activity.
Distinct human authors establish observed participation; ownership alone does
not establish that a person wrote or visited.

Run `npm run build -w @beeline/server`, then
`node --import tsx scripts/prove-workspace-walk-history.mjs`. This synthetic
stand-in exercises the built reservation, SQL-page and receipt path: historical
messages excluded from a first daily read appear across two bounded weekly
pages; human and agent authors remain distinct; ownership is verified; complete
coverage leaves no daily backlog. It emits no message text. Workflow integration
cases also exercise daily and Monday kickoff, while service-review regressions
cover history reopening, consent rechecks and internal-workspace exclusion.
The live scheduled production run still requires deployment.
