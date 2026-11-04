# Linux desktop continuation audit

2026-11-04. Continuation after the first desktop repair merged. Built the actual
Linux preview AppImage from main at `96dcef923`, walked every requested surface
against production, then integrated main's router activation (`bfc7d8a86`) for the
final fixed build. The implementation contains only the sheet state and Escape
fixes described below; upstream router changes are part of the base.

The dedicated Play Review identity stayed in Beeline Review Workspace
`bee11e00-0000-4000-8000-000000000105`, proof Room
`bee11e00-0000-4000-8000-000000000103`, and its existing idle corner. No captain
Workspace, agent provisioning, approval response or corner lifecycle was used.
One uniquely named audit message per build was sent and reacted to. A temporary bookmark was removed.

The build follows `.github/workflows/desktop.yml`: build the four shared packages,
then `npm run tauri:build:preview -- --target x86_64-unknown-linux-gnu --bundles
appimage` in `apps/mobile`. Its own extracted `AppRun` ran in a task-owned X display,
D-Bus session, HOME/XDG directories and kernel session keyring, with persistent
keyring lookup denied. Native input used X11. Production web comparison used
`chrome-devtools-axi` in a separate private profile at the same window widths;
that deployment was `v0.1.143 · 3efb501ff3e4`.

## Confirmed breakages

1. **Add-agent forgets the provider on resize.** Select Codex in the compact
   sheet, widen the window, and Grok Bot becomes selected. `HullActionSheet`
   inserted a ScrollView (or View for non-scrolling bodies) only for desktop or
   pinned chrome. Crossing that boundary remounted the child. The body now keeps
   its parent component in both layouts; the existing desktop height cap and
   pinned chrome remain in place. The regression uses the real provider selector
   and fails on the original source for both body modes.
2. **Escape closes the sheet and leaves the page underneath it.** Open Members
   from Tray, open Add-agent, press Escape: the app returns to Tray. The global
   navigation hook handled keydown before React Native Web's Modal handled keyup;
   a directly mounted sheet is absent from ModalProvider's managed stack. Global
   route navigation now yields while a web modal is present, including its opening
   transition. A browser regression mounts the actual web Modal: the first Escape
   closes it without routing, and a subsequent Escape still navigates back. It
   fails against the original hook. Production web reproduced the same bug.

| Reproduction | Before | After |
| --- | --- | --- |
| Codex selection lost when compact becomes wide | [Selected before resize](main-add-agent-narrow-dark-codex-redacted.png), [reset after widening](main-add-agent-resize-wide-dark-redacted.png) | [Codex retained wide](fixed-add-agent-resize-wide-dark-redacted.png), [retained compact](fixed-add-agent-resize-narrow-dark-redacted.png) |
| Escape leaves Members after closing Add-agent | [Returned to Tray](main-after-sheet-escape-wide-dark.png); [web returned to Room](current-web-after-sheet-escape-wide-dark.png) | [Members remains](fixed-after-sheet-escape-wide-dark.png), [compact remains](fixed-after-sheet-escape-narrow-dark.png) |

Command text is masked in the evidence; no command was executed.

## Per-surface results

Reviewed against DESIGN.md's Bone/Obsidian tokens and existing layout. The two
issues above are the additional breakages found; no new design was introduced.

| Surface | Result and native screenshots |
| --- | --- |
| Sign-in state | Fresh signed-out [wide](main-signin-wide-bone.png) and [compact](main-signin-narrow-bone.png) fit. Authorized review-link sign-in succeeded. [Restart retained the session](main-session-retained-wide-bone.png). OAuth remains outside this proof. |
| Room list | [Wide](main-session-retained-wide-bone.png) has one sidebar and an accessible account control. Search found the proof Room. [Compact](main-room-list-narrow-bone.png) still has one list. |
| Open Room / send | [Room](main-room-wide-bone-ready.png), [send](main-send-wide-bone.png), [delivered reaction](main-reaction-wide-bone.png). Canonical read confirms exactly one `desktop-audit-main-96dcef923-20261104`, with 👍1. [Copy/paste](main-copy-paste-wide-bone.png) and [reply](main-reply-wide-bone.png) target that message; the draft was cleared without sending again. |
| Transcript scroll | [Older history](main-transcript-scroll-wide-bone.png) renders under actual mouse-wheel input; the composer stays accessible. Long text wraps and the latest-message affordance remains visible. |
| Reactions / picker | [Open picker](main-picker-wide-bone.png) and [selected reaction](main-reaction-wide-bone.png) fit above the composer. The earlier row-toolbar resize repair remains in the base. |
| Corners | [Bone list](main-corners-wide-bone.png), [Obsidian list](main-corners-wide-dark.png), [compact list](main-corners-narrow-dark.png); existing idle corner [wide](main-corner-wide-dark.png) / [compact](main-corner-narrow-dark-ready.png) fit. No lifecycle control was invoked. |
| Tray | Bookmark appears in Saved [wide](main-tray-wide-bone.png) / [compact](main-tray-narrow-bone.png). After removal, [wide Obsidian](main-tray-wide-dark.png) / [compact Obsidian](main-tray-narrow-dark.png) show the empty state. The existing Needs you item was neither answered nor cleared. |
| Members | People/agent counts and Add controls fit in [Bone](main-members-wide-bone.png), [Obsidian](main-members-wide-dark.png), and [compact](main-members-narrow-dark-ready.png). Opening the viewer routes to their existing Settings surface. |
| Settings | [Bone wide](main-settings-wide-bone.png) / [compact](main-settings-narrow-bone.png), [Obsidian wide](main-settings-wide-dark-ready.png) / [compact](main-settings-narrow-dark.png), and [Large interface size](main-settings-narrow-large-dark.png) fit. Workspace tab [wide](main-workspace-settings-wide-dark.png) / [compact](main-workspace-settings-narrow-dark.png) fits without changing Workspace settings. |
| Add-agent | Existing provider controls and both command controls fit [wide](main-add-agent-wide-dark-redacted.png), [compact](main-add-agent-narrow-dark-codex-redacted.png), and at [minimum 480×480](main-add-agent-min-dark-redacted.png). Provider selection and dismissal exposed the two fixed bugs above. |
| Window resizing | Room layouts fit at [767](main-room-767-dark.png), [768](main-room-768-dark.png), and [1920](main-room-ultrawide-dark.png) px. The previous duplicated sidebar and orphan-toggle failures did not recur. |
| Themes | Bone and Obsidian coverage is linked above; theme and interface-size pickers work. The final sheet proof repeats both themes after the fix. |

Matching production web comparisons:
[sign-in](current-web-signin-wide.png), [Room 1280](current-web-room-wide-dark.png),
[Room 480](current-web-room-narrow-dark.png), [Members 1280](current-web-members-wide-dark.png),
[Members 480](current-web-members-narrow-dark.png), [Settings 480](current-web-settings-narrow-dark.png),
[Large Settings 480](current-web-settings-narrow-large-dark.png),
[Workspace Settings 480](current-web-workspace-settings-narrow-dark.png),
[Tray 1280](current-web-tray-wide-dark.png), [Tray 480](current-web-tray-narrow-dark.png),
[corners 1280](current-web-corners-wide-dark.png), and
[Add-agent 1280](current-web-add-agent-wide-dark-redacted.png).

## Errors and performance

WebKit's native console-output setting captured app console messages. An early
observer used a custom script-message channel that Tauri also treated as IPC,
producing diagnostic “missing field cmd” errors. That observer was replaced
before the clean walkthrough with a saved native console-info sink; it does not
wrap or replace the app's console. Only the clean interval is included in the
published metrics. It recorded zero native console errors and zero uncaught JS
errors/rejections. Production web had notification-environment warnings and a
form-field id/name accessibility advisory, with no console errors.

The 150 ms interaction / 450 ms load budgets still are not established as passing.
[Current-main observations](main-metrics.json) include first Room readiness 794 ms,
then 205 ms on a repeat; corners 314 ms, Members 367 ms and Add-agent 173 ms.
18 of 88 input-to-second-frame samples exceeded 150 ms, maximum 740 ms. Some
later samples overlap local validation/build work on this shared host. These are
upper bounds, not isolated regressions or server/network attribution.

## Validation and remaining coverage

- 86 focused sheet, modal, member-picker, browser-width, Android inset and design
  tests passed; the new selection regression fails on the original source.
- 7 browser-navigation tests passed, including the actual web-Modal Escape
  regression, which fails on the original hook.
- Root typecheck passed again after integrating main.
- `npm run dead-code` passed: 5 existing findings, 0 introduced. The browser
  proof is registered as an esbuild entry; the baseline is unchanged.
- The final official AppImage build passed, then the native reproductions passed
  in both themes and in compact/wide layouts.
- No new outstanding layout/control breakage was found beyond the two repaired.
  Performance attribution/budget closure, macOS/Windows, GitHub/Google OAuth and
  OS notification delivery/reboot persistence remain follow-ups.

## Final integrated build

Source: `c3dbff1dc779a1b86ac033a1d11c1631d25dd417`, including main
`bfc7d8a86031981613abff6636ea12bc5d4a4abc`. The [native Settings footer](fixed-settings-footer-wide-bone.png)
shows the embedded `c3dbff1dc779` source. This is the preview identity and local
`0.2.20` packaging version, not a release.

| AppImage | SHA-256 |
| --- | --- |
| Clean main baseline, `96dcef923a205f697388c7f357959494cffac5a9` | `4a00c2f908d1744289337f1bfecfebd92d299260f00c88f6d834bcd1bb42d496` |
| Final integrated patch | `02e9694a77ab841bba77325b55ae582049c191681377bd8a8234753e4487f1f2` |

Final native checks also covered:

- [Session retained across the binary replacement](fixed-session-retained-wide-dark.png).
- [Muse at 480×480 in Obsidian](fixed-add-agent-min-dark-muse-redacted.png),
  [Bone](fixed-add-agent-min-bone-muse-redacted.png), and
  [still selected after widening](fixed-add-agent-resize-wide-bone-muse-redacted.png).
- [Escape leaves Members in Bone](fixed-after-sheet-escape-wide-bone.png);
  [the interface-size picker leaves Settings](fixed-after-picker-escape-wide-bone.png).
- [Room at 480 px](fixed-room-narrow-bone.png),
  [picker after widening](fixed-picker-after-resize-wide-bone.png), and
  [✅ applied](fixed-reaction-after-resize-wide-bone.png).
  The canonical read confirms exactly one `desktop-audit-complete-c3dbff1-20261104`,
  id `813ad4165da4f93a82925a44ed004c579cc352962fa1c62e29eb2942272d431c`, with ✅1.
- [Tray](fixed-tray-wide-bone.png), [corners](fixed-corners-wide-bone.png),
  [existing idle corner](fixed-corner-wide-bone.png), and
  [Settings](fixed-settings-wide-bone.png) remained usable on the integrated router.

[Final observations](fixed-metrics.json), collected after local builds/checks
finished, again recorded zero native console errors and zero uncaught JS
errors/rejections. On this shared host, 16 of 76 input-to-second-frame samples
exceeded 150 ms (maximum 887 ms); first Room readiness was 922 ms, Settings
509/461 ms, Members 372 ms and Add-agent 226 ms. Performance remains a follow-up;
the visual/control repairs do not establish the latency budgets as passing.

One intermediate package process was terminated while bundling. It is not a
proof artifact. The final integrated build completed successfully and is the
one launched for all `fixed-*` screenshots above.
