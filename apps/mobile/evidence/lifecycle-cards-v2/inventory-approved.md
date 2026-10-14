# Lifecycle card inventory — Revision 2 approval

Inspected current PR #2468 head, 954ae7348. No implementation changes for Revision 2 yet.

## Rendered card variants

Common entry file: `apps/mobile/sources/app/(app)/beeline/chat/RoomMessageVariants.tsx`.
Common grouped file: `apps/mobile/sources/components/buzz/PrLifecycleCard.tsx`.

| Variant | Current renderer / file | Current divergence / proposed alignment |
| --- | --- | --- |
| Corner opened, no source-message marker, with/without PR metadata | `DaemonFactCard` in entry file | Corner-name header, author in header, objective as body, Open action, no opened state row. Use Corner · 1 opened shell, state/title/meta/author row; keep objective and Corner navigation. |
| Corner completed/merged, PR present | `DaemonFactCard` → `NotificationLifecycleCard` | Already aligned by revision 1, but card shell is separate from TranscriptCard. Move onto common lifecycle shell and row. |
| Corner completed/landed, no PR present (legacy) | Same as above | Currently labelled PR despite no PR. Use Corner kind and existing state; no invented external destination. |
| Corner abandoned/closed, PR present | Same as above | Shared row already; ensure single and grouped kinds/state/meta agree. Both actions when destinations exist. |
| Corner abandoned/closed, no PR | `DaemonFactCard` → `RepositoryFactCard` → `TranscriptCard` | Name header, regular title, no row author; keep Corner navigation and unify anatomy. |
| Worktree cleaned, standalone | Same fallback chain | Closed corner with different shell/title treatment; keep navigation. Cleanup-only runs still do not create new grouped cells. |
| Corner checks-failing fact | Same fallback chain | Name header, failed row, Open action, missing per-row author and external action despite PR data. Align existing fields and available destinations. |
| Standalone PR opened/merged/closed and other supported action strings | `GitHubEventCard` → `RepositoryFactCard` | Header lacks dot, author in header, regular row title, generic PR meta, external action primary. Use shared shell and row; external-only View remains primary when no internal destination exists. |
| Standalone issue opened/closed and other supported action strings | Same GitHub chain | Same differences; use Issue kind and preserve available issue metadata, never synthesize corner/PR fields. |
| Grouped PR/corner/issue and mixed repository run | `NotificationLifecycleCard` in grouped file | Own hand-built shell, header always PR except checks (including issue-only/mixed runs); summary author in header as well as row author. Use shared shell, canonical row author, appropriate kind from existing item kinds. |
| Grouped presented row | `CornerPrRow.tsx` | Revision 1 extracted state/title/meta/author/actions; extend semantic coverage without adding data. |
| Grouped expanded non-presented selection row | Contracted row JSX in `PrLifecycleCard.tsx` | Separate compact title/state/meta, author embedded in meta, no actions. Render using shared row anatomy; retain existing collapse count, ordering, selection and settle behavior. |
| GitHub check started/running, passed, failed (standalone and grouped) | `foldPrLifecycleRuns` → `NotificationLifecycleCard` | Check kind supported, but still separate shell and contracted rows. Use shared shell/row; preserve existing head SHA, consequence and live corner-header reconciliation. |

## Routing and shared primitives

- `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:5905`: mobile and main web transcript route grouped runs, GitHub events, source markers and daemon facts separately.
- `apps/mobile/sources/components/DesktopRoomInspector.tsx:483`: same card components in desktop inspector; standalone daemon Corner callback is currently a no-op, unlike grouped rows. Wire the existing `onOpenCorner` callback during alignment.
- `apps/mobile/sources/components/buzz/TranscriptCard.tsx`: generic record/ask shell and regular row, card-level footer. Keep unrelated approvals, polls and artifacts out of this migration.
- `apps/mobile/sources/components/buzz/CornerPrRow.tsx`: current PR-specific shared row; generalize for the existing corner/PR/issue/check field set.
- `apps/mobile/sources/buzz/pr-lifecycle.ts`: presentation projection, grouping and deduplication; preserve boundaries, identities, ordering and N-more behavior. Revision 1 retained the existing PR URL so both destinations remain available; no server schema/event change.
- `apps/mobile/sources/buzz/system-lines.ts`: actual structured corner types are corner-open, corner-complete, checks-failing and worktree-cleaned. GitHub event type/action strings are open-ended; only existing supported render paths are migrated.

## Related inline surfaces — boundary for approval

These are not lifecycle cards today. Preserve them as inline surfaces; do not create cards or restore retired features:

- `components/buzz/CornerOpenedMarker.tsx`: source-message Corner opened/closed marker, glyph and Open text; used by `_chat-surface.tsx` for `sourceMessageId` facts. Preserve attachment to source message and navigation.
- `components/buzz/CornerStatusLine.tsx` and `buzz/corner-status-line.ts`: current PR/check/review state above corner transcript, deliberately unframed. Existing header source stays authoritative.
- `components/buzz/CornerWorkingPulse.tsx`, `CornerWaitingPulse.tsx`, `RoomCornersList.tsx`, `DesktopRoomCorners.tsx`: working/waiting/review state on navigation/list surfaces, not event cards.
- `components/buzz/Ledger.tsx` and `buzz/system-lines.ts`: ordinary server-phrased working/review/merge lifecycle notices remain ledger lines. There is no separate working or review event-card renderer to migrate.
- Unsupported GitHub CI/deployment types currently return null in `GitHubEventCard`; do not restore them. Existing structured GitHub check notices do render through the check run above.
- Permission/target-branch asks, welcome illustrations, corner-app launch rows and repository-selection controls are operational controls, not lifecycle notification cards.

## Proposed visual contract

One LifecycleCard shell owns frame/header/timestamp; one LifecycleRow owns state, strong title, existing kind/meta, row author and actions. No repeated author summary in the shell. Header: Kind · summary. PR-only: PR; issue-only: Issue; corner without PR: Corner; checks: Check; mixed kind runs: Activity. Missing fields stay absent. Single and one-row groups use identical geometry. Internal Corner is filled primary; View quiet secondary when both exist, otherwise View is the sole primary action. Existing objective text stays readable inside the opened-corner row. Existing expander hides/reveals the same identities; expanded visible rows share the full anatomy and actions.

## Proof plan after approval

Android before/after in Bone and Obsidian for every rendered variant above, including expanded selection rows and closed/no-PR navigation; shared-shell/row component tests and retained historical grouping tests; authenticated browser proof on web.usebeeline.app using the approved GitHub reviewer bypass. Live-site proof can verify the deployed baseline; changed code must also be demonstrated in a matching local/preview build until deployed. No claim that local changes are deployed to the production site.
