# Tray badge and cached empty Tray

## Reproduction TRAY-CACHED-EMPTY-1

The owner reported Android showing a badge of 5, then Needs you 0 and Saved 6.
Read-only production inspection on 2026-10-13 found five current question
candidates in Tubing Crew, all with a first-seen mark and none cleared:

| Message ID | Source | Request |
| --- | --- | --- |
| `c53c0ec355dab81afab8cd5b51e1cd504534d6f4de6a6f08703c012a58b80439` | experiments | System merge decision |
| `a5bd26f290869e5aebe07378d588ee6b246b4fc08b22aac0659f77e2ba12523b` | issues-triage | Ruby report offering push recovery choices |
| `8e987bb7065aa11b8f1e6cff239229b7f7a0592f8dd35b5ba110703f649f6fad` | issues-triage | Ruby report asking for push access |
| `29e2526577e205113c71481f65d11356e4fb238bc41f3082777b528137aca837` | issues-triage | Ruby report describing owner approval for push recovery |
| `3886922ed0b5af2e9b7ed5a668930fbd0b62b7efdb96f07f096367764c82bb74` | issues-triage | Ruby report mentioning approval and feedback |

The badge's `countNeedsYou` and Tray's `readNeedsYou` use the same server
candidates and visibility predicate. These five texts also pass the Tray's
TypeScript ask predicate. Bookmarks use a separate query and never badge.

Trusty Squire reached the owner's already signed-in `web.usebeeline.app`
session. Opening Tray showed badge 5, Needs you 5, Saved 6 and all five rows.
Nothing was dismissed, answered, cleared or opened. The original Android
session's disk contents were not available for inspection; the cached-empty
cause is reproduced locally, rather than asserted as a recovered phone trace.

Before the fix, a rendered regression loaded badge 5 from the server, then
opened Tray with cached `{ items: [] }` and six cached bookmarks. Opening
accepted both disk sections without `readTray`, leaving visible rows and
badge at 0. This reproduces the reported transition from 5 to an empty Tray.

Opening now paints the disk response immediately and validates it with
`readTray`. The shared store then shows five rows and badge 5. A foreground
transition refreshes an open Tray or invalidates the closed Tray's badge,
even when its socket remains connected; old count responses cannot overwrite
that refresh. No polling was added.

## Demonstrated

Local headless Chrome ran the actual Tray, toolbar and shared store with
transport and device shims. `tray-cache-proof.tsx` prints:

```
PASS Reproduction TRAY-CACHED-EMPTY-1: badge before 5; open cached empty Tray with six Saved; visible Needs you 5, badge 5, Saved6CLEAR
```

`tray-cache.png` captures that rendered proof. Run from `apps/mobile`:

```
mkdir -p /tmp/tray-badge-proof
BEELINE_DESIGN_PROOF_DIR=/tmp/tray-badge-proof npx vitest run 'sources/app/(app)/beeline/needs-you-badge.browser.test.ts'
```

Rendered tests also cover 0/1/5 Needs you with six Saved, dismissal, failed
dismissal, section clear/Undo, live resolution, foreground with Tray open or
closed, foreground during a delayed count, gaps and account switches. The
toolbar test verifies that a zero badge is hidden.
