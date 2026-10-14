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

There are 24 cases × 2 themes. The 21 original cases have e43783c79 before shots; `issue-group-of-one` has a 329612dfc before shot (see Reproduction lifecycle-cards-3); the two nameless cases have eb30c471b before shots (see Reproduction lifecycle-cards-4). The paired matrix below
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
| issue-group-of-one | [PNG](android-prefix-bone-issue-group-of-one.png) (329612dfc) | [PNG](android-after-bone-issue-group-of-one.png) | [PNG](android-prefix-obsidian-issue-group-of-one.png) (329612dfc) | [PNG](android-after-obsidian-issue-group-of-one.png) |
| corner-merged-pr-nameless | [PNG](android-prefix-bone-corner-merged-pr-nameless.png) (eb30c471b) | [PNG](android-after-bone-corner-merged-pr-nameless.png) | [PNG](android-prefix-obsidian-corner-merged-pr-nameless.png) (eb30c471b) | [PNG](android-after-obsidian-corner-merged-pr-nameless.png) |
| nameless-group-of-one | [PNG](android-prefix-bone-nameless-group-of-one.png) (eb30c471b) | [PNG](android-after-bone-nameless-group-of-one.png) | [PNG](android-prefix-obsidian-nameless-group-of-one.png) (eb30c471b) | [PNG](android-after-obsidian-nameless-group-of-one.png) |
| grouped-issues | [PNG](android-before-bone-grouped-issues.png) | [PNG](android-after-bone-grouped-issues.png) | [PNG](android-before-obsidian-grouped-issues.png) | [PNG](android-after-obsidian-grouped-issues.png) |
| mixed-activity | [PNG](android-before-bone-mixed-activity.png) | [PNG](android-after-bone-mixed-activity.png) | [PNG](android-before-obsidian-mixed-activity.png) | [PNG](android-after-obsidian-mixed-activity.png) |
| check-started | [PNG](android-before-bone-check-started.png) | [PNG](android-after-bone-check-started.png) | [PNG](android-before-obsidian-check-started.png) | [PNG](android-after-obsidian-check-started.png) |
| check-passed | [PNG](android-before-bone-check-passed.png) | [PNG](android-after-bone-check-passed.png) | [PNG](android-before-obsidian-check-passed.png) | [PNG](android-after-obsidian-check-passed.png) |
| check-failed | [PNG](android-before-bone-check-failed.png) | [PNG](android-after-bone-check-failed.png) | [PNG](android-before-obsidian-check-failed.png) | [PNG](android-after-obsidian-check-failed.png) |

[Native before manifest](android-before-results.json) · [Native after manifest](android-after-results.json)

#### Reproduction lifecycle-cards-3: issue meta line

Review of 329612dfc found that a standalone issue card showed `Issue #2468`,
but the same issue as a deduplicated group of one showed `issue`. The fold
used a different meta line from the standalone adapter. The `issue-group-of-one`
case was added for this. It did not exist at e43783c79, so its before
screenshots come from a native build of 329612dfc:
[Bone](android-prefix-bone-issue-group-of-one.png), [Obsidian](android-prefix-obsidian-issue-group-of-one.png),
next to the standalone card at the same commit:
[Bone](android-prefix-bone-github-issue-opened.png), [Obsidian](android-prefix-obsidian-github-issue-opened.png).
Grouped issue rows at that commit: [grouped Bone](android-prefix-bone-grouped-issues.png),
[mixed Bone](android-prefix-bone-mixed-activity.png) ([manifest](android-prefix-results.json)).
The grouped fold now writes `Issue #N`. Both paths show `Issue #2468` in both themes. All after cases were recaptured.

#### Reproduction lifecycle-cards-4: nameless legacy corner title

Review of eb30c471b found that a merged corner card written before corners had
names showed a different title as a standalone card and as a group of one.
Fixture: `name` undefined, objective "Keep every lifecycle card consistent across
both platforms", PR title "Align lifecycle cards". The standalone card used the
three-word name derived from the objective (`Keep every lifecycle`). The grouped
fold used `name ?? pullRequest.title ?? objective` (`Align lifecycle cards`).
Before shots come from a native build of eb30c471b plus the two new fixtures:
[standalone Bone](android-prefix-bone-corner-merged-pr-nameless.png),
[group of one Bone](android-prefix-bone-nameless-group-of-one.png), and the same
in Obsidian. The local web proof at that code fails with
`nameless single/group-of-one row content` ([Bone](web-prefix-bone-nameless.png)).
Both paths now call `lifecycleCornerTitle`, so both show `Keep every lifecycle`
in both themes on Android and local web.

### Browser: local changed code

The actual production components render the same 24 cases through React Native
Web in headless Chrome, both themes. Every action is clicked and its exact
corner/URL callback checked. The test checks header kinds, no header author,
no horizontal overflow and identical single/group-of-one content and row
geometry for the merged corner, the nameless legacy corner and the opened issue, plus an identical issue header. Screenshots carry a **LOCAL BUILD** banner:
[Bone](web-local-bone.png), [Obsidian](web-local-obsidian.png).
Results: [Bone](web-local-bone-results.json), [Obsidian](web-local-obsidian-results.json).

### Browser: deployed app — required after release

Brief revision 3 moves the reviewer-bypass browser check on
`web.usebeeline.app` to **after release**, explicitly outside the merge gate.
The pre-merge browser proof is the local PR build above. The live check is not
obtained yet; after this change is released, sign in through the GitHub reviewer
bypass and verify these variants on the deployed app, labeling the evidence as
production. No local screenshot is claimed to be from the live site. No
Usebeeline connection grant is required for pre-merge proof.

## Validation and repeat

- Component cases exercise every adapter with the shared shell/row, all available
  destinations and expanded-row actions. Existing single/group-of-one tests are
  retained with the replacement row's name.
- Existing historical lifecycle, stacking, check reconciliation, closed-corner,
  source-marker and desktop contract assertions remain unchanged from the revision-2 baseline. Added coverage
  exercises the inspector's standalone Corner navigation.
- Focused card, grouping, check and desktop suites pass (184 tests across 4 files), plus the two-theme local web proof. The full mobile suite passes except load timeouts in unrelated browser files and a local native-fingerprint run polluted by fixture build output. Root typecheck, UI component policy, design checks and DEAD CODE pass. The
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
