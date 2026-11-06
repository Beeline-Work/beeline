# AI app pages: native Android proof (PR #3959)

Reproduction AI-APP-LOGOS / AI-APP-PAGE, on a native Android phone (emulator, 1080 × 2400).

- **Before:** production screens from origin/main `a2e196acdc55b68828e1cf8977a9997a1465701b` (Connectors, connector page, AiClientsSection), fed the old server shape (letter tiles, "Reads and posts" subtitles, no agent).
- **After:** this branch at `423c1abedee3`, fed the new server shape (logos, linked agent).

## How it was built

1. The fixture app (`apps/mobile/evidence/ai-app-pages/fixture`) mounts the production Connectors route and connector page through Expo Router. It replaces only the phone-operation transport, identity, community and storage modules with in-memory fixtures. Fixture: ChatGPT → Pidoong, Claude Code → Claude, Cursor → Cursor bot, Legacy app with no agent. Logo bytes come from the server's `mcpClientLogo`.
2. `build-android-fixture.sh <before|after> <bone|obsidian>` bundles that app with `expo export:embed`, compiles it with hermesc (bytecode 96, same as the APK), and puts it in a copy of a Beeline release APK (0.2.22, built from `da9f6c31`, an ancestor of this branch with the same native dependencies). It then zip-aligns, signs with a throwaway key and installs the APK.
3. `capture-android.py` opens `beeline:///?viewerId=fixture-owner&workspaceId=fixture-workspace`, waits for the rows, taps ChatGPT and saves each screen.

## Steps and results

| Step | Before (main) | After (this branch) |
|---|---|---|
| Open Connectors | `phone-before-*-list.png`: letter tiles (C, C, C, L), "Reads and posts · connected … · used …" | `phone-after-*-list.png`: OpenAI logo, Claude logo, bot face for Cursor and Legacy app; "Connected as <agent>"; no dates |
| Tap ChatGPT | `phone-before-*-row-tap.png`: Disconnect sheet opens at once; no info page | `phone-after-*-info.png`: full page with Status "Connected", description, Agent (Pidoong), What it can do, "Connected Oct 31 · last used today". The script fails if Disconnect shows here. |
| Tap Status | no Status row exists | `phone-after-*-status.png`: the shared sheet with Disconnect |
| Tap Disconnect | — | `phone-after-*-disconnected.png`: back on Connectors; ChatGPT gone, other rows kept. The script fails if ChatGPT is still listed. |

Themes: Bone and Obsidian (`*-bone-*`, `*-obsidian-*`).

## Stand-in

This is not a signed-in production account. Phone operations come from the fixture. The server part (logos, agent names) is covered by the server tests in this PR. The local Gradle build cannot run here because its native dependencies are read-only. Expo Go cannot run the app because it lacks NitroModules. The re-signed release APK has the real native modules, so these screens are the production React Native code rendered natively.
