# Usage resets and agent refresh — R-USAGE-1

## Reproduced

R-USAGE-1: open the owner's Cursor agent Profile → Usage. Each window displays
`↻ <time>` as plain text, which looks like a broken refresh control. There is
no actual refresh action. Free allowance repeats the misleading glyph.

The owner's Nerd Android capture reported this path. For repeatable before/after
proof without owner sign-in, the native fixture mounts the baseline and changed
production Usage sections with a real Cursor snapshot from the owner's reader.
The free allowance is synthetic. Both themes run in the same current Android
debug binary on leased emulator-5570. Fixture navigation controls are below Usage.
The unchanged fixture identity label above the free variant is not a live agent.

## Demonstrated

- `cursor-before-{bone,obsidian}.png`: baseline repeated glyphs.
- `cursor-after-{bone,obsidian}.png`: one shared reset in the footer; Grok Bot's
  distinct reset stays below that meter. One accessible refresh button.
- `free-before-{bone,obsidian}.png` and `free-after-{bone,obsidian}.png`: reset text,
  token allowance and shared-account note; no refresh button.
- `refresh-live.mp4` and `cursor-refreshed-bone.png`: an Android tap changes the
  visible updated time from 5:01 PM to 5:05 PM. `live-proof.json` records exactly
  one request and one helper frame with changed committed timestamps.

The tap calls the real owner-only PhoneService operation on an isolated PGlite
service, its PostgreSQL notification listener, the actual daemon WebSocket, the
DaemonApiClient callback, createUsageRefresh, the actual pinned quota-axi Cursor
reader, and the actual daemon postAgentUsage operation. A small fixture HTTP
wrapper returns the committed agent read to the native component after the helper
finishes; production uses its existing live surface invalidation instead. Local
authentication binds only fixed test identities. No production database is written.
This proves the component and new request path, not production deployment.

Grok Bot is Cursor's own weekly account meter: quota-axi calls GetSandUsageStatus
with the same Cursor token as GetCurrentPeriodUsage/GetPlanInfo. It is retained.

## Repeat

1. `npm run corner:prepare` and build the current Android debug app for x86_64.
2. Read a real Cursor snapshot with HarnessQuotaReader into
   `.scratch/usage-refresh/cursor-live.json` (only figures, never credentials).
3. Run `node --import tsx scripts/prove-agent-usage-refresh.mjs`.
4. Temporarily register `apps/mobile/scripts/agent-usage-refresh-native-proof.tsx`
   from mobile's index.ts; restore the normal entry after capture. Run Metro on
   an IPv4 reachable port and open the installed development client.
5. Use the fixture's Theme, Free/Cursor and Before/After controls for the captures.
   Tap the production Refresh usage target once to exercise the live reader.

The baseline component is retained only as a proof fixture and is never imported
by the normal application entry.
