# Lifecycle card alignment — Revision 2

[Approved inventory and boundary](inventory-approved.md)

## Reproduced

Reproduction lifecycle-cards-2 extends corner-pr-cards-1: render the inventory's
standalone corner facts, repository events and grouped runs. Before revision 2,
standalone opened/closed corners and GitHub events still used `RepositoryFactCard`
and `TranscriptCard`, while grouped runs used a separate frame. Headers, author
placement, title weight, expanded rows and action styles differed. The desktop
inspector's standalone corner action was also wired to a no-op.

The before native fixture uses PR head `e43783c79`, before the expanded UI work.
The after fixture uses this branch's new shared components. Android 36 x86_64,
1080×2400 at 420 dpi, in a `beeline emulator` leased instance. These screenshots
are local native fixture builds, not production sessions. Each screenshot shows
its variant name, and filenames identify phase/theme/source. The fixture uses
real card adapters, fonts, themes and folding with deterministic data.

## Demonstrated

Reproduction lifecycle-cards-2 now uses `LifecycleCard` and `LifecycleRow` across
all adapters. Replaced repository/card and contracted-row JSX has been deleted.
The shell owns the frame/header/stamp; author attribution is confined to each
row. Opened corners preserve their prior attribution wording and full objective.
Every visible expanded row has the same anatomy and available actions.

Internal Corner is first/filled, GitHub View is second/quiet; external-only rows
have one filled View. Header kinds use existing item kinds; mixed runs say
Activity and corners without PRs say Corner. The desktop inspector now passes
its real `onOpenCorner`. No grouping, deduplication, item identity, server DTO,
source marker or inline working/review/status behavior is changed.

### Android before and after

There are 21 cases × 2 themes × 2 phases (84 PNGs). The paired matrix below
covers opened, merged and closed corners with/without PRs, cleanup, failing
checks, PR and issue events, expanded/grouped/one-item/mixed runs, and all check
states. The JSON manifests record native visible text, available actions and
source labels. The after driver checks canonical headers and available actions,
including all three actions on the expanded two-row case.

| Variant | Bone before | Bone after | Obsidian before | Obsidian after |
| --- | --- | --- | --- | --- |
| corner-open-no-pr | [PNG](android-before-bone-corner-open-no-pr.png) | [PNG](android-after-bone-corner-open-no-pr.png) | [PNG](android-before-obsidian-corner-open-no-pr.png) | [PNG](android-after-obsidian-corner-open-no-pr.png) |
| corner-open-pr | [PNG](android-before-bone-corner-open-pr.png) | [PNG](android-after-bone-corner-open-pr.png) | [PNG](android-before-obsidian-corner-open-pr.png) | [PNG](android-after-obsidian-corner-open-pr.png) |
| corner-merged-pr | [PNG](android-before-bone-corner-merged-pr.png) | [PNG](android-after-bone-corner-merged-pr.png) | [PNG](android-before-obsidian-corner-merged-pr.png) | [PNG](android-after-obsidian-corner-merged-pr.png) |
| corner-merged-no-pr | [PNG](android-before-bone-corner-merged-no-pr.png) | [PNG](android-after-bone-corner-merged-no-pr.png) | [PNG](android-before-obsidian-corner-merged-no-pr.png) | [PNG](android-after-obsidian-corner-merged-no-pr.png) |
| corner-closed-pr | [PNG](android-before-bone-corner-closed-pr.png) | [PNG](android-after-bone-corner-closed-pr.png) | [PNG](android-before-obsidian-corner-closed-pr.png) | [PNG](android-after-obsidian-corner-closed-pr.png) |
| corner-closed-no-pr | [PNG](android-before-bone-corner-closed-no-pr.png) | [PNG](android-after-bone-corner-closed-no-pr.png) | [PNG](android-before-obsidian-corner-closed-no-pr.png) | [PNG](android-after-obsidian-corner-closed-no-pr.png) |
| worktree-cleaned | [PNG](android-before-bone-worktree-cleaned.png) | [PNG](android-after-bone-worktree-cleaned.png) | [PNG](android-before-obsidian-worktree-cleaned.png) | [PNG](android-after-obsidian-worktree-cleaned.png) |
| corner-checks-failing | [PNG](android-before-bone-corner-checks-failing.png) | [PNG](android-after-bone-corner-checks-failing.png) | [PNG](android-before-obsidian-corner-checks-failing.png) | [PNG](android-after-obsidian-corner-checks-failing.png) |
| github-pr-opened | [PNG](android-before-bone-github-pr-opened.png) | [PNG](android-after-bone-github-pr-opened.png) | [PNG](android-before-obsidian-github-pr-opened.png) | [PNG](android-after-obsidian-github-pr-opened.png) |
| github-pr-merged | [PNG](android-before-bone-github-pr-merged.png) | [PNG](android-after-bone-github-pr-merged.png) | [PNG](android-before-obsidian-github-pr-merged.png) | [PNG](android-after-obsidian-github-pr-merged.png) |
| github-pr-closed | [PNG](android-before-bone-github-pr-closed.png) | [PNG](android-after-bone-github-pr-closed.png) | [PNG](android-before-obsidian-github-pr-closed.png) | [PNG](android-after-obsidian-github-pr-closed.png) |
| github-issue-opened | [PNG](android-before-bone-github-issue-opened.png) | [PNG](android-after-bone-github-issue-opened.png) | [PNG](android-before-obsidian-github-issue-opened.png) | [PNG](android-after-obsidian-github-issue-opened.png) |
| github-issue-closed | [PNG](android-before-bone-github-issue-closed.png) | [PNG](android-after-bone-github-issue-closed.png) | [PNG](android-before-obsidian-github-issue-closed.png) | [PNG](android-after-obsidian-github-issue-closed.png) |
| grouped-corners | [PNG](android-before-bone-grouped-corners.png) | [PNG](android-after-bone-grouped-corners.png) | [PNG](android-before-obsidian-grouped-corners.png) | [PNG](android-after-obsidian-grouped-corners.png) |
| grouped-expanded | [PNG](android-before-bone-grouped-expanded.png) | [PNG](android-after-bone-grouped-expanded.png) | [PNG](android-before-obsidian-grouped-expanded.png) | [PNG](android-after-obsidian-grouped-expanded.png) |
| group-of-one | [PNG](android-before-bone-group-of-one.png) | [PNG](android-after-bone-group-of-one.png) | [PNG](android-before-obsidian-group-of-one.png) | [PNG](android-after-obsidian-group-of-one.png) |
| grouped-issues | [PNG](android-before-bone-grouped-issues.png) | [PNG](android-after-bone-grouped-issues.png) | [PNG](android-before-obsidian-grouped-issues.png) | [PNG](android-after-obsidian-grouped-issues.png) |
| mixed-activity | [PNG](android-before-bone-mixed-activity.png) | [PNG](android-after-bone-mixed-activity.png) | [PNG](android-before-obsidian-mixed-activity.png) | [PNG](android-after-obsidian-mixed-activity.png) |
| check-started | [PNG](android-before-bone-check-started.png) | [PNG](android-after-bone-check-started.png) | [PNG](android-before-obsidian-check-started.png) | [PNG](android-after-obsidian-check-started.png) |
| check-passed | [PNG](android-before-bone-check-passed.png) | [PNG](android-after-bone-check-passed.png) | [PNG](android-before-obsidian-check-passed.png) | [PNG](android-after-obsidian-check-passed.png) |
| check-failed | [PNG](android-before-bone-check-failed.png) | [PNG](android-after-bone-check-failed.png) | [PNG](android-before-obsidian-check-failed.png) | [PNG](android-after-obsidian-check-failed.png) |

[Native before manifest](android-before-results.json) · [Native after manifest](android-after-results.json)

### Browser: local changed code

The actual production components render the same 21 cases through React Native
Web in headless Chrome, both themes. Every action is clicked and its exact
corner/URL callback checked. The test checks header kinds, no header author,
no horizontal overflow and identical merged single/group-of-one content and
row geometry. Screenshots carry a **LOCAL BUILD** banner:
[Bone](web-local-bone.png), [Obsidian](web-local-obsidian.png).
Results: [Bone](web-local-bone-results.json), [Obsidian](web-local-obsidian-results.json).

### Browser: deployed baseline — pending

The required reviewer-bypass session on `web.usebeeline.app` is **not obtained**.
The first connection attempt returned Registry unavailable. A subsequent attempt
resolved Usebeeline and requested owner connection approval (grant
`0922f02f-0ed9-4975-924b-8b5946858234`). That approval is pending. The checked
reviewer-related vault service names and session environment exposed no reviewer
bypass credential. No owner session was substituted, and no local screenshot is
claimed to be from the live site. This acceptance item remains blocked until the
connection and required reviewer sign-in are available.

## Validation and repeat

- Component cases exercise every adapter with the shared shell/row, all available
  destinations and expanded-row actions. Existing single/group-of-one tests are
  retained with the replacement row's name.
- Existing historical lifecycle, stacking, check reconciliation, closed-corner,
  source-marker and desktop contract assertions remain unchanged from the revision-2 baseline. Added coverage
  exercises the inspector's standalone Corner navigation.
- The final 214-test suite passes across 11 files. Root typecheck, UI component policy, design checks and DEAD CODE pass. The
  native proof remains an explicit Knip entry point; no baseline expansion.

From `apps/mobile`:

```sh
LIFECYCLE_PROOF_OUT=evidence/lifecycle-cards-v2 npx vitest run sources/test/lifecycle-cards.browser.test.ts
```

Native fixture setup is the same as `../corner-pr-cards/README.md`: Gradle
`entryFile` points to `scripts/corner-pr-cards-native-proof.tsx`, updates disabled,
x86_64 release build. Then from the root:

```sh
python3 apps/mobile/scripts/lifecycle-cards-android-proof.py --device emulator-5558 --phase after --out apps/mobile/evidence/lifecycle-cards-v2
```

Proof data lives in `scripts/lifecycle-card-fixtures.ts`, shared by native,
component and browser proofs. Generated Android files and APKs are not committed.
