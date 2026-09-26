# Onboarding redesign — real-app evidence

These frames come from the real Expo web client, running against a real local server and a
disposable local PostgreSQL database. They are not mocks. Every account is a development-only
`local:` identity; no production Workspace or account was touched.

## Capture recipe

1. Start a fresh `postgres:16` container. Run this branch's release migration
   (`node --import tsx apps/server/src/index.ts --migrate`), which creates the schema and seeds
   nothing.
2. Start the server on `127.0.0.1:19191` with `NODE_ENV=development`, a local auth tenant, and
   `BEELINE_WEB_APP_ORIGINS` set to the Expo web origin.
3. Recreate the production shape this release retires:
   - exchange `local:welcomeonly` and `local:crewmate`;
   - run the base commit's `seedDefaultWorkspace` body verbatim (constants inlined), which
     backfills both into Beeline Welcome;
   - add a `Greeter` agent subscribed to `joined` in `#welcome`, with a live daemon token;
   - give `crewmate` a second Workspace of its own.
4. Start Expo web on `:19106` with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:19191`.
   Sign an identity in by writing its exchanged refresh token and identity id into
   `sessionStorage`.
5. Drive and capture with `chrome-devtools-axi`:
   - mobile at 390×844 (DPR 2), desktop at 1440×900;
   - dark scheme;
   - one account per viewport, because changing the viewport reloads the page.
6. The final starter-prompt and invite-retry frames come from a second session on the final
   branch head, with the server on `:19291` and Expo web on `:19206`. For the agent state,
   `@owl` was inserted into `#general` directly in that disposable database, standing in for a
   completed pairing. The offline state used Chrome's network emulation.

## Welcome / Greeter retirement (local)

- `preflight-before.json`: the read-only preflight
  (`index.js --welcome-retirement-preflight`) before arming. It shows 3 active members,
  1 person with no other Workspace, and the Greeter with one live token.
- `retirement-migration.txt`: the armed release migration
  (`BEELINE_RETIRE_WELCOME_GREETER_ID=<exact id>`), then a retry, which reports
  `already-complete`.
  - Arming it with the display name `Greeter` was refused, and nothing changed.
- `preflight-after.json` and `retirement-after.txt` were read after a server restart. They show:
  - no Welcome Workspace, Room, or memberships;
  - the Greeter hidden, its token revoked, and its agent row kept;
  - both people kept;
  - a system audit row;
  - the completion marker.
- `00-before-welcome-only-user-mobile.png` shows the Welcome-only person before retirement.
  `01-choice-mobile.png` and `20-welcome-only-after-retirement-desktop.png` show the same
  person afterwards, landing on the choice screen.

## Frames

| Flow | Mobile 390×844 | Desktop 1440×900 |
| --- | --- | --- |
| Choice (Create / Join, equal weight) | `01-choice-mobile.png` | `01-choice-desktop.png` |
| Create 1 — Workspace name + picture | `02-create-step1-workspace-mobile.png` | `22-create-step1-desktop.png` |
| Create 2 — name + Beeline face | `03-create-step2-profile-mobile.png` | `23-create-step2-desktop.png` |
| Create 3 — invite link + agent command | `04-create-step3-crew-mobile.png` | `24-create-step3-desktop.png` |
| First Room `#general` + tour card 1/4 | `05-first-room-tour-card1-mobile.png` | `25-first-room-tour-desktop.png` |
| Tour cards 2–4 | `05-tour-card{2,3,4}-mobile.png` | — |
| Starters, Workspace with no agent (Connect an agent + Invite someone) | `06-first-room-starter-prompts-mobile.png` | `26-first-room-starter-desktop.png` |
| Connect an agent → pairing command | `06-first-room-connect-agent-mobile.png` | — |
| Starters once an agent (`@owl`) is in the Room; tap fills the live composer | `06-first-room-starter-filled-mobile.png` | — |
| Spotlight 1/3 — Room list | `07-tip-rooms-mobile.png` | `27-tip-rooms-desktop.png` |
| Spotlight 2/3 — corner | `08-tip-corner-mobile.png` | — |
| Spotlight 3/3 — Workbench | `09-tip-workbench-mobile.png` | — |
| Settings → Help → Replay product tour | `10-settings-replay-mobile.png`, `10-replay-opens-tour-mobile.png` | — |
| Invite opened before sign-in (kept) | `11-invite-before-signin-mobile.png` | — |
| Invite confirmation after sign-in | `12-invite-confirm-mobile.png` | `28-invite-confirm-desktop.png` |
| Joined → first Room + tour | `13-invite-joined-first-room-mobile.png` | — |
| Dead invite repair state | `14-invite-unavailable-mobile.png` | — |
| Invite opened offline → "Couldn't reach Beeline" (invite kept) | `15-invite-unreachable-mobile.png` | — |
| Back online → Retry → confirmation | `15-invite-retry-confirm-mobile.png` | — |

## Tour library spike

`spike/` holds the one-screen Expo 55 / React Native 0.83.1 (Fabric) spike and its frames.
The spike ran as a release APK on a private Android emulator and on Expo web; iOS could not be
run on this Linux host.

- `react-native-spotlight-tour@4.0.0` fails the required conditions:
  - it forces an RN `Modal` that draws over the app's own sheet (`web-spotlight-over-sheet-390.png`);
  - neither Escape nor Android back dismisses it (`android-spotlight-after-back.png`);
  - with no mounted target it pins its tooltip to (0,0) over a full scrim
    (`web-spotlight-unmounted-390.png`);
  - on Android its cutout sits about one status bar above the target.
- `react-native-copilot` blanks the whole web app with a runtime error, and on Android back
  does nothing.
- `rn-tourguide` draws no spotlight on Android Fabric (`android-tourguide-mounted.png`), and on
  web it throws on every frame (`web-tourguide-mounted-390.png`).
- `react-joyride` and `driver.js` are DOM-only.

No candidate passed, so the tour is a small in-house sequencer on components Beeline already
ships (`apps/mobile/sources/components/buzz/tour/`). Firstmate made that call under the
captain's delegation.
