# AI app pages fixture app (PR #3959)

This small Expo Router app renders the production Connectors route and connector page, with the production components, theme, fonts and sheet. It never signs in or contacts a server.

Only these modules are swapped, by `metro.config.js`:

- `stubs/identity.ts`: a signed-in fixture owner.
- `stubs/community.ts`: the fixture Workspace.
- `stubs/transport.ts`: returns the Workbench data in `fixture.json` and handles Disconnect in memory. Every other phone operation throws. With `PROOF_BEFORE=1` it removes the new agent and logo fields, so it shows the old server shape.
- `stubs/live.ts`: no live socket.
- `stubs/storage.ts`, `stubs/mmkv.ts`: in-memory storage.

`before/` holds main's copies of the changed screens (`AiClientsSection.tsx`, `workbench.tsx`, `service.tsx`). They are used only with `PROOF_BEFORE=1`.

Fixture data: ChatGPT linked to Pidoong, Claude Code linked to Claude, Cursor linked to Cursor bot, and "Legacy app" with no agent. The logo bytes come from the server's `mcpClientLogo`.

## Run on web (no phone needed)

Needs `npm ci` at the repository root (it installs `apps/mobile/node_modules`). From this directory:

```sh
PROOF_BEFORE=0 EXPO_PUBLIC_PROOF_BEFORE=0 EXPO_OFFLINE=1 CI=1 \
  ../../../node_modules/.bin/expo export --clear --platform web --max-workers 2 --output-dir web-after
mkdir -p web-after/v1/agent-avatars && cp avatar-assets/* web-after/v1/agent-avatars/
python3 -I serve-web.py "$PWD/web-after" &
./check-web-flow.sh /tmp/ai-app-proof-shots
```

Open `http://127.0.0.1:18764/?viewerId=fixture-owner&workspaceId=fixture-workspace&theme=bone` (or `theme=obsidian`).

`check-web-flow.sh` drives this path in headless Chrome for Bone and Obsidian, saves screenshots and prints PASS or FAIL per theme. By hand: tap ChatGPT, which opens the info page. Tap the Status row, which opens the sheet. Tap Disconnect, which returns to Connectors without ChatGPT. Legacy app's page has no Agent section and says "last used not yet".

For the old screens, use `PROOF_BEFORE=1 EXPO_PUBLIC_PROOF_BEFORE=1` and `--output-dir web-before`.

## Run on Android

See `../README.md` and `../build-android-fixture.sh`.
