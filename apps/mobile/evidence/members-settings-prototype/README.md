# Revision 2: native members and settings prototype

Design review only. No merge or release.

These are unedited Android API 36 emulator screenshots of the full Beeline app, signed in through its ordinary review sign-in route. The app uses real authentication, server DTOs, navigation, profiles, settings, fonts, and themes. `server.mts` runs an isolated in-memory PGlite server with seeded people, agents, Rooms, messages and a DM. No production account, database, credentials or deployment is involved. This replaces the rejected revision-1 standalone component fixture.

## Captures

- `01-before-bone.png`: current Room list before the prototype.
- `02-after-bone.png`: Members added; existing Tray action moved to the header, including its badge behavior. Overflow and compose remain where they were. Filters and search remain where they were.
- `03-search-bone.png`: the existing search field with `r` typed; people and agents appear above the existing results. The app calls the existing indexed Workspace-members search endpoint; no search stub or server change was needed.
- `04-admin-settings-bone.png`: signed-in Workspace owner sees the Workspace section below the existing personal sections. It reuses the actual picture/mark, Name, public join link, Visibility, fix-sweep, Members and owner-only Delete controls. No illustrative settings rows were added. Owner/admin/member gating is also covered by renderer tests.
- `05-non-admin-settings-bone.png`: the same authenticated device, with its membership changed to member on the isolated server and the app restarted, reaches the end of Settings without a Workspace section.
- `06-after-obsidian.png`: Room list in Obsidian.
- `08-human-profile-proof.png`, `09-agent-profile-proof.png`: tapping the respective search result opens the existing profile route.
- `10-settings-personal-bone.png`: unchanged profile, Connectors, Device and Account sections at the top of Settings.

XML receipts accompany the user paths. `11-members-page.xml` records the existing Members page reached from the new top-bar glyph. `positions.json` verifies identical native bounds before/after for All, Unread, Pinned, search, overflow, compose, and the Workspace mark. The Workspace trigger starts in the same place; its available width shrinks to accommodate the two added header targets.

## Questions for owner review

- Keep the duplicate Members and Workspace settings entries in the overflow menu? They remain unchanged pending the owner's answer.
- Is the denser top bar acceptable, especially for longer Workspace names? This device fits the short “Beeline” name; no extra layout changes were made to solve longer names.

## Reproduction

1. Run `npm run corner:prepare`.
2. Run `node --import tsx apps/mobile/evidence/members-settings-prototype/server.mts` from the repository root. It binds only loopback ports 45861 and 45862 and holds all data in memory.
3. Boot a private device using `beeline emulator -avd fm-members-frames -no-window -gpu swiftshader_indirect`; select that device explicitly with adb.
4. Install the app's debug APK. Start Metro from `apps/mobile` with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:45861 npx expo start --dev-client --port 18081 --host lan --max-workers 2`.
5. Open the Expo development-client link for `http://10.0.2.2:18081`, dismiss the development menu and hide its Tools button, then open `beeline://review/isolated-design-proof-secret-5678`. This value belongs only to the local test server.
6. Navigate through the actual app controls. `device.py` provides bounded inspect/tap/screenshot actions for the recorded leased serial; update its serial for a fresh lease.
7. For the non-admin proof, request `http://127.0.0.1:45861/_proof/role/member`, restart the app, and open Settings again. The server changes only that local seeded membership; the app still uses the real saved device session.
8. Select Dark using the existing Appearance setting for Obsidian.

The baseline was captured using the original `channels.tsx` against the same server and session; the prototype file was then restored. The app entry point and production server configuration were never replaced by a screenshot harness.

Validation: root typecheck, UI component policy, 92 focused mobile tests (including design/calm lints, existing Workspace settings, Tray, Room-list live behavior and owner/admin/member section gating), plus the personal-settings suites. The Impeccable mechanical scan returned no findings. This is not a defect report.
