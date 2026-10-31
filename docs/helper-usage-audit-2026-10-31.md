# Squire helper usage audit — 31 October 2026

This extends the October 25 helper-cleanup-audit report and
[archived cleanup evidence](archived-corner-cleanup-audit.md). No one-time
cleanup has been performed. Measurements below are allocated blocks or RSS,
not apparent file sizes or unique physical memory. They are snapshots while
other corners are working, not a growth-rate measurement.

## Ranked disk findings

| Category | Allocated size | Creator and cleanup owner | Finding |
| --- | ---: | --- | --- |
| Corner checkouts | 278 GiB, 182 directories | Room runtime; storage owner reconciliation | Archived: 217 GiB / 144 directories. Active: 56 GiB / 16. Unmatched to this Room: 4.7 GiB / 22; not assumed archived. |
| Agent homes | 101.3 GiB | Agent home setup and tools; helper storage reclamation | Must measure outside the turn namespace. Emberus's archived voice-pin-freeze home alone retains 24.2 GiB and has running processes. |
| Repositories | 22.3 GiB | Canonical clones; host disk retention | Linked worktrees and unpublished branches deliberately prevent expiry. Individual publication checks remain required. |
| Workspace assets | 16.1 GiB, 4 directories | Workspace asset setup; host disk retention | Shared tools, caches and Android assets; hidden by the turn sandbox. |
| Room checkouts | 6.35 GiB | Room checkout setup; storage owner reconciliation | Preserve dirty and unpublished work. |
| Legacy dependency stores | 4.38 GiB combined | Warm dependency harvest; cache retention | Workspace-layout corners explicitly bypass the ABI-unsafe legacy store. Existing stores do not imply sharing is active. |
| Helper directory | 128 MiB | Helper runtime | Logging must remain bounded by existing log retention. |
| Recovery and rescue | 108 MiB combined | Recovery paths | Not disposable without recovery ownership checks. |

These categories are not a synchronized host-wide total. A sandbox scan omits
most agent homes and workspace assets. The new logger runs in the native helper
and includes scan timestamps, errors and pending status rather than presenting
an incomplete scan as zero usage.

The largest archived checkout (05e3bb30) contains verification output
(13.5 GiB), including copied history, Gradle data and a dependency snapshot.
`git status --porcelain` reports untracked verification directories. The dirty
checkout guard is working as designed. These legacy directories lack the
explicit disposable manifest required by `corner-proof-output.ts`; the existing
seven-day proof policy cannot silently classify them as disposable.

Dependency reuse has two separate obstacles: workspace-layout materialization
skips the legacy store, and `corner:prepare` runs `npm ci`, replacing any seeded
root tree. Mobile postinstall patches installed files. Sharing writable inodes
or re-enabling the legacy cache without ABI and mutation isolation proof is not
a safe fix. Squire's checkout filesystem is ext4; reflink availability must be
proved, not assumed.

## Process findings

The built usage sampler observed emulators (13.48 GiB RSS, 3), CodeGraph
(2.90 GiB, 15), harnesses (1.29 GiB, 10), and other attributable processes
(13.76 GiB, 156). These are transient counts. The standalone proof process is
labelled helper by the sampler; its RSS is not the production helper's RSS.
The sample reported unreadable/racing process records (8), so it is explicitly
partial. RSS sums include shared pages.

* The archived voice-pin-freeze corner (282235fb) still owns an emulator
  (5.73 GiB RSS) and the pin test server (262 MiB). Both process working
  directories identify that checkout. The emulator instance belongs to
  Emberus's home. This is an attributable retention candidate, not permission
  to kill arbitrary Android devices.
* Other observed emulators belong to current helper work, including the
  standing release corner. Idle turn status alone is not abandonment: corner
  emulators deliberately survive turns.
* Old CodeGraph releases remain children of Claude processes in the firstmate
  checkouts. Release age is insufficient evidence of orphaning. Do not reap
  them solely by executable version.
* The old `src/worker.ts` process is in Docker container
  `buzzrouter-worker-1`, image `buzzrouter-self-hosted:latest`. Excluded from
  Beeline cleanup.
* The collector backend and Trusty Squire broker are excluded from cleanup.
  Squire's singleton and its browsers are not orphaned helper sessions.

## Logging and proof

`helper-usage.ts` emits a structured usage line every five minutes on native
Linux helpers. Disk snapshots run asynchronously at most every six hours,
with a ten-minute subprocess limit and no overlapping scans. Metadata walks
use O_NOATIME, avoid symlinks and other filesystems, and count hardlinked inodes
once. Subcategories include dependencies, CodeGraph, Android instances, tmp,
attachments and logs. Entries are filesystem entries, not package counts.

Process sampling reports same-user helper descendants and processes rooted in
helper state. It never reads environment variables or logs command arguments.
Its classifications are observations, never deletion authority. Cleanup counts
and freed bytes are cumulative for this helper lifetime and cover the machine
retention and archived-member callbacks wired here, not every historical action.
Free-agent runtime behavior is unchanged.

Feature proof: not a defect report. Built module invoked on squire through
`systemd-run --user --pipe --wait`, outside the turn namespace. Process output
was returned with category counts and RSS. Disk proof completed with 432.3 GiB allocated and one inaccessible/racing entry. Corner dependencies account for 90.4 GiB and CodeGraph for 40.5 GiB; agent Android instances account for 27.4 GiB, dependencies for 18.9 GiB, tmp for 3.7 GiB, attachments for 51 MiB and logs for 13 MiB. Counts are inode-deduplicated; categories receiving a shared inode depend on traversal order.
Focused tests exercise real metadata traversal: hardlink deduplication, symlink
avoidance, unchanged directory atime, and process summaries without raw paths.

## ARCHIVED-OUTPUT-1 fix and proof

The reconciliation path previously considered ignored generated output only
for open owners. Archived dirty trees therefore retained old dependencies,
builds and indexes even when the whole checkout correctly failed publication
and cleanliness checks. The same conservative unused-object path now accepts
confirmed archived owners and includes ignored CodeGraph indexes. The host
archive sweep also invokes it using persisted ended-owner facts. Seven-day
idle age, process/mount/lease checks, tracked-file guards and host scheduling
remain in force. No arbitrary verification directory becomes disposable.

The isolated regression failed for archived=true before the fix and passes
afterward. `node scripts/prove-archived-output.mjs` exercises the built storage
report and host sweep: the report identifies stale output without deleting it,
the sweep deletes build/index output, and dirty unpublished source survives.
This stand-in avoids deleting live squire data before fixes land.

## Remaining work

Obtain independent review of this first logging/retention fix. The archived emulator is owned by the custom pinfreeze-emu-r3.service and has no kept-emulator record. Dependency sharing still needs ABI-safe mutation isolation; broad process reaping remains inappropriate for unproven orphans. One-time cleanup remains deferred until fixes land; dirty checkouts and
unpublished work remain protected.


## Orphan-first follow-up (brief revision 3)

The attached repository CSV records every observed folder, state, close date,
allocation snapshot, uncommitted work, and commits absent from local origin
refs. Across accessible Rooms: open (23, 54.75 GiB), archived (156, 223.18 GiB),
and inaccessible lifecycle (3, retained as unknown). Git and lifecycle reads
were taken after the allocation snapshot; this is not an atomic inventory.

Archived preservation reasons: dirty trees (118, 118.36 GiB), publication guard
(9, 29.80 GiB), unavailable git evidence (5, 2.10 GiB), declared proof retention
(20, 44.09 GiB), observed process use (2, 23.96 GiB), and missing persisted
archive facts (2, 4.88 GiB). These are sampled reasons, not evidence that earlier
cleanup attempts ran or failed. Local origin refs may be stale; one-time removal
must revalidate publication and cleanliness immediately before applying.

The close path is wired: authoritative storage facts reach Room reconciliation
and the machine archive listener, which persist ended ownership and call
`reclaimOwnedCheckout`. The six-hour host sweep retries persisted ended owners.
The guards above explain why most folders cannot be removed wholesale.

ARCHIVE-FACT-1 disproves the suspected bootstrap membership bug: on a migrated
PGlite database, a parent-only member receives its archived child in bootstrap
storage facts with zero direct corner membership rows. Top-level discovery
remains limited to the parent and unrelated Rooms stay excluded.
`CornerAccessDatabase` rewrites the SELECT to `effective_memberships`. No query
change is justified. Missing persisted facts are not proof that this query
failed; delivery/reconciliation timing remains unproven for those two folders.

Usage lines now count corner folders as open, orphaned (confirmed archived),
or unknown. Live storage facts and persisted ended-owner records supply the
classification; missing facts never imply orphaning. Counts read only immediate
folder entries and owner metadata, with no recursive disk walk. A failed count
is null rather than a false zero.

Built host count proof after this change returned open (23), orphaned (158),
unknown (1). Compared with the API-only audit, persisted ended-owner records
classify two inaccessible folders as archived; no missing-state inference was
used. Live folder inventories can also change between snapshots.
