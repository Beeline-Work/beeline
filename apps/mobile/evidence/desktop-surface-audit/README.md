# Linux desktop surface audit

2026-11-04. Real Tauri/WebKitGTK windows, built from current main
`525dfedb5e1f351e4493a8c2bbf52f5d41a49568`, against the production server.
The fixed build contains this PR's frame-policy and row-presentation changes on
that base.

The dedicated Play Review identity used only Beeline Review, Workspace
`bee11e00-0000-4000-8000-000000000105`, and its proof Room
`bee11e00-0000-4000-8000-000000000103`. No captain Workspace was opened.
Review credentials were read through the approved production environment route,
exchanged over HTTPS, and kept in private mode-0600 task files and a private
kernel session keyring. HOME, XDG paths, X display and D-Bus session were isolated;
persistent-keyring lookup was denied. No helper or shared daemon was driven.

Both native builds use the preview AppImage path in `.github/workflows/desktop.yml`:
shared packages built first, then `npm run tauri:build:preview -- --target
x86_64-unknown-linux-gnu --bundles appimage` from `apps/mobile`. Each resulting
AppImage was extracted and its own `AppRun` launched. WebKitGTK version: 2.52.6.
A task-local observation-only preload recorded trusted input to the second
animation frame, semantic content readiness and uncaught JavaScript failures;
it changed neither API origin, credentials IPC, components nor layout. Native
pointer/keyboard/window input used X11; browser comparisons used a private
`chrome-devtools-axi` session at matching widths. The comparison web deployment
was v0.1.142, source `98c2a49a4f3d`, so it is explicitly a deployed-web comparison.

## Confirmed breakage and fix

At 480 px, native shell policy forced a permanent 300 px sidebar while the Room
deck and subpages selected their existing compact layouts. This rendered two
Room lists, squeezed the Room composer field to about 32 px, and clipped Settings.
`desktop-shell-policy.ts` now selects the permanent frame and session chrome
using the same live width class as the Room deck. Wide-window session gating
continues to require sign-in. Compact windows reuse the existing compact UI.

The Room-list toggle also follows that class, so a compact Room cannot offer
Hide/Show for a sidebar that is absent. The policy and toggle regressions fail
against the original source and pass with the fix.

## Scope and remaining work

Linux native coverage does not establish macOS or Windows behavior. GitHub/Google
OAuth was not exercised: fresh signed-out screens and the authorized review-link
sign-in were checked. Existing corners and the Add-agent sheet were opened;
no agent was provisioned, no approval answered and no corner lifecycle started.
OS notification delivery and OS reboot credential persistence were not tested.

## Validation

- Root `npm run typecheck` passed.
- 75 focused tests passed with `--maxWorkers=2`: desktop shell policy/toggle, layout
  contracts, reaction-picker pointer behavior, sheet widths/scrolling, pane
  sizing, design tokens, typography, memoized row identity and final-message paint.
- Native baseline and fixed AppImage builds succeeded.

## Surface walkthrough

All native links below are actual WebKit windows, not Chromium component fixtures.

| Surface | Evidence and result |
| --- | --- |
| Fresh sign-in | [1280 px](native-signin-wide-light.png), [480 px](native-signin-narrow-light.png): GitHub/Google controls fit; no authenticated sidebar. Approved review-link exchange succeeded. |
| Room list | [Wide Bone](native-room-list-wide-light.png): list selection, title, filters and account control fit. Compact before/after below. |
| Open Room and send | [Room](native-room-wide-light.png), [sent](native-send-wide-light.png): native keyboard Enter sends text; canonical server read confirms one `desktop-audit-native-20261104`. |
| Transcript scrolling | [Scrolled history](native-transcript-scroll-wide-light.png): real mouse-wheel input reveals older rows; composer stays accessible. |
| Reactions/picker | [Open](native-picker-wide-light.png), [pointer on thumb](native-picker-hover-wide-light.png), [selected](native-reaction-wide-light.png): picker remains above the transcript edge; server confirms 👍1 on the intended message. |
| Corners | [List](native-corners-wide-light.png), [existing idle corner](native-corner-wide-light.png): full title/objective and empty transcript fit; no lifecycle action started. |
| Tray | [Wide Obsidian](native-tray-wide-dark.png): existing Needs you item and Saved empty state render. No decision or dismissal performed. |
| Members | [Bone](native-members-wide-light.png), [Obsidian](native-members-wide-dark.png): people/agent sections, search and Add controls render. |
| Settings | [Bone](native-settings-wide-light.png), [Obsidian](native-settings-wide-dark.png), [1920 px](native-settings-ultrawide-dark.png): existing rows and theme selection work. |
| Add-agent sheet | [Bone](native-add-agent-wide-light-redacted.png), [Obsidian](native-add-agent-wide-dark-redacted.png): providers and command controls fit; Escape dismisses. Command contents are redacted. No agent connected. |

Production web comparison screenshots at the same widths:
[Room 1280](web-room-wide.png), [Room 480](web-room-narrow-dark.png),
[Members 1280](web-members-wide-dark.png), [Settings 480](web-settings-narrow-dark.png),
[Tray 1280](web-tray-wide-dark.png), [corner 1280](web-corner-wide-dark.png),
[Add-agent 1280](web-add-agent-wide-dark-redacted.png).

## Performance follow-up

The 150 ms interaction / 450 ms content-load budgets are **not established as
passing**. Baseline native semantic readiness samples exceeded 450 ms: first
proof-Room open 1801 ms, corners 1642 ms, Members 661 ms, Add-agent sheet 480 ms,
and Settings 651 ms; a repeated Settings visit took 244 ms. Input-to-second-frame
samples also exceeded 150 ms. The production web sample had 1 of 56 inputs over
150 ms, maximum 201.2 ms. See [native trace](baseline-metrics.json) and
[web trace](web-input-metrics.json).

These are instrumented upper bounds on this shared Linux host, with compilation
overlapping part of the baseline. They locate budget misses, not isolated
performance regressions or server/network attribution. A quiet-host content-load
and input trace is a follow-up; this patch only repairs the demonstrated layout
and control failures. A content-marker timeout from the diagnostic observer is
not an application timeout: the Tray loaded visually and is shown above.

### Cached row controls after resizing

A separate native reproduction opened the proof Room at 480 px, widened to
1280 px and hovered a message. Cached rows kept compact Reply controls instead
of exposing the desktop Copy/Reply/React toolbar. The Room renderer knew the new
width class, but `RoomMessageCell` received unchanged scalar props and correctly
skipped its renderer. The layout class now travels explicitly in
`RoomMessagePresentation`, and ordinary rows consume that value.

The reaction-picker browser regression projects the real Room presentation's
layout fields through the production memo boundary, opens compact, resizes wide,
clicks React and an emoji, then resizes compact again. Against the original Room
wiring it fails because the desktop React control never appears. Ordinary
arrival/typing/identity tests continue to require unchanged rows to skip redraws.

## Before/after evidence

| Reproduction | Before | Complete patch |
| --- | --- | --- |
| Duplicate compact Room lists, Bone 480 px | [Before](native-initial-narrow-light.png) | [After](native-complete-room-list-narrow-light.png) |
| Squeezed Room/composer, Obsidian 480 px | [Before](native-room-narrow-dark-before.png) | [After](native-complete-room-narrow-dark.png) |
| Clipped Settings, Obsidian 480 px | [Before](native-settings-narrow-dark-before.png) | [After](native-complete-settings-narrow-dark.png) |
| Orphan sidebar toggle after the initial policy repair | [Before](native-fixed-hidden-toggle-before.png) | [After: existing Back, no orphan toggle](native-complete-room-narrow-dark.png) |
| Cached compact row controls after widening | [Before](native-resize-controls-before.png) | [After: desktop picker](native-complete-resize-picker-dark.png), [selected](native-complete-resize-reaction-dark.png) |

The complete patch also retained exactly one list at [767 px](native-complete-room-list-767-dark.png)
and [768 px](native-complete-room-list-768-dark.png), and the [full compact Settings
layout in Bone](native-complete-settings-narrow-light.png). Related compact checks:
[Members](native-fixed-members-narrow-light.png), [Tray](native-fixed-tray-narrow-light.png),
[Add-agent, Codex selected](native-final-add-agent-narrow-dark-redacted.png), and
[480×480 Add-agent sheet](native-fixed-add-agent-min-window-light-redacted.png).
The Codex selector and native clipboard copy were checked without printing or
executing the join instructions. The wide sidebar Hide/Show controls also worked.

[Canonical probe reads](canonical-probes.json) confirm one final
`desktop-audit-final-narrow-20261104`, with 👀1 selected through the native picker
after widening. Two intermediate diagnostic sends deliberately reused the
`desktop-audit-fixed-narrow-20261104` text; those are two separate UI submissions,
not a duplicate-delivery finding.

[Complete-build observations](complete-metrics.json) recorded zero uncaught JS
errors/rejections. The browser console had no errors; initial web warnings were
notification permission/unavailable native notification API and a replaced live
socket during session setup. A complete native console stream was not captured.
A discarded console-wrapper experiment interfered with logging; it was removed,
the task app restarted, and the final resize/picker pass repeated without it.
The diagnostic experiment is excluded from the published performance traces.
Complete-build content readiness still exceeded 450 ms: Room 873 ms and Settings
1206 ms. Performance remains an explicit follow-up.

### AppImage provenance

All four builds use `Beeline Preview_0.2.20_amd64.AppImage` (local preview version,
not a release). Source manifests name the base commit; the changed builds were
exported from the worktree containing the corresponding patch.

| Build | SHA-256 |
| --- | --- |
| Main baseline | `175d3c689d6803b85723f5ae7b741337cf5bd32bb09a2b292f32fe86ab4ebc82` |
| Initial frame policy, before toggle guard | `c821d5486023ad3a19b65c3fd4bffee07e3f56471d8fdd67f919a137ecdab642` |
| Frame/toggle repair, before row-layout repair | `c62e9c89044545b9c1306a69e2d91233382adc0b543ce8340d0025c2f411a81a` |
| Complete patch | `21c02b1dbb1ad925bc7e10f75cc137508ba892b9fbb635fe0dc67f1e94714aec` |
