# Viewer modal keyboard proof

Reproduction VIEWER-MODAL-IME-1: open the HTML viewer fixture, expand Talk to agent, tap Message and type Explain. Repeat in computer mode. Before changing production code, both modal paths placed the pill bottom at y=603 while Gboard began at y=1517: a 914 physical-pixel gap. The extra 883 pixels equal one keyboard height.

The release fixture mounts the production HullModal (fill), KeyboardProvider, ViewerConversationDock and ConversationComposer above a real script-disabled HTML WebView. The clean emulator has no authenticated artifact or live computer session. HTML and computer transport are local fixture boundaries; this does not claim an authenticated file download, steering or screen capture. Caller tests verify ArtifactViewerScreen selects parent avoidance and ComputerSessionViewer selects it only outside the warm host.

After the fix, repeat the same path: the pill bottom is y=1486 and Gboard begins at y=1517 in artifact, modal computer and warm computer modes. The 31 physical-pixel gap is the rounded 12 React Native dp gap at 420 dpi (scale 2.625). Dismissing the keyboard restores each resting position; screenshots retain that result. Obsidian and Bone captures are included. Samsung Keyboard is not installed; Gboard is the available IME. No iOS proof was requested.

## Cause and scope

HullModal already avoids the keyboard. Its keyboard-controller migration (#621) and fill placement (#1282) predate #2612. The #2612 proof fixture mounted the dock without HullModal, so its standalone keyboard lift was useful there but doubled the actual modal movement. The later #2865 ArtifactViewer/HullDialog changes migrated controls without changing that keyboard boundary. No newly introduced resize change was established.

Artifact viewers and modal computer viewers now use the parent's displacement. The warm native computer host is a full-screen sibling of the navigator, outside HullModal, and retains its own displacement. Transcript height still reserves keyboard space. Web's native-only lift remains disabled.

## Web evidence and outstanding acceptance

Trusty Squire opened production web.usebeeline.app in its existing lunchboxfortwo session, opened “Desktop proportions audit — before and after” in the full-screen artifact viewer, expanded Talk to agent and focused Message without sending. production-web-focused.png shows the composer at the bottom (y=924 in a 936-pixel viewport, 12-pixel gap). The existing HTML renderer reports unavailable, so this capture establishes viewer/composer placement, not successful HTML rendering. This branch is not deployed.

The specifically requested GitHub reviewer-bypass session remains outstanding. Connectors and vault metadata confirm beeline-reviewer-bypass / play-review-login-link, but operate_login(load_saved, fields:[value]) returned `POST /v1/vault/browser-fill → 400 unsupported_credential_type`. Navigation accepts a plaintext URL and no sealed-link navigation operation is exposed. No raw credential was fetched. A live browser card was opened in this corner and sign-in handback requested. Existing-owner-session proof is not claimed as reviewer-bypass proof. The commander must obtain that handback or decide whether the existing-session and local web proof suffice.

## Rebuild and checks

Run corner:prepare, then from apps/mobile run `npx expo prebuild --platform android --no-install`. Set generated android/app/build.gradle entryFile to `file("../../scripts/viewer-dock-keyboard-native.tsx")` and extraPackagerArgs to `["--max-workers", "2"]`; disable Expo Updates in the generated manifest. Build assembleRelease with x86_64, two workers, Xmx4g and MaxMetaspaceSize=1g. Install on this corner's emulator only. Switch viewer selects artifact/modal computer; Warm computer viewer moves the same dock outside HullModal. Capture UIAutomator pill bounds and InputMethod touchable region from dumpsys window. Native projects and APKs are ignored; hashes and measured evidence are retained here.

Validation: root npm run typecheck; mobile ViewerConversationDock, ArtifactViewer, ComputerSession, ViewerConversationDock.browser, design-lint and calm-lint suites (95 tests passed); git diff --check. The new regressions cover modal displacement only once in both viewer kinds, dismissal, transcript bounds and caller wiring; existing tests preserve standalone native and web behavior.
