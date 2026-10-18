# Agent usage proof (brief revision 4, mock r7)

This is a feature, not a defect report. The design authority is mock r7, which the owner approved, and corner brief revision 4. The screenshots show the production React Native Web profile and Members row, rendered in Chrome with sample data. The Android image shows the production Usage cell in an Expo Go host.

## Provider → server → profile and usage tool

`apps/body/src/fixtures/claude-rate-limit-event.json` is a `rate_limit_event` captured from a real Claude turn on squire on 2026-10-18. Only the random identifiers were removed.

- [server-tests.txt](server-tests.txt): `apps/server/src/agent-usage.integration.test.ts` sends the captured event through the daemon parser and the authenticated `postAgentUsage` operation into a migrated database. It then reads the result through the profile API, the Members API and `getAgentUsage`. It checks:
  - windows merge per type, and a stop is kept without an invented percentage;
  - older reports and other agents' writes are refused;
  - non-owners see nothing, and one agent cannot read another agent's usage;
  - the free allowance resets at midnight UTC, and the paused state shows no money;
  - OpenRouter key spend is stored.
- [contract-tests.txt](contract-tests.txt): parsing, the 30-minute old rule, and the summary sentence for each agent type. Free-agent sentences contain no `$`.
- [body-tests.txt](body-tests.txt):
  - Mapping of the OpenRouter `/api/v1/key` answer. A key with nothing left counts as reached.
  - The key goes only in the request header. Reads happen at most once a minute, and only for Pi, Goose or OpenCode on an OpenRouter model.
  - The `read` facet `usage` always reads the calling agent.
  - The Room turn trace shows no usage line in the assembled prompt and no per-turn usage read.
- [mobile-tests.txt](mobile-tests.txt):
  - The Usage cell's columns, the brass threshold at exactly 80%, red when stopped or paused, old data after 30 minutes, and the no-source line.
  - The Members text appears only at 80% or more, or when the agent is stopped or paused.

## Real turn: an agent answers from its usage tool

[usage-tool-turn.txt](usage-tool-turn.txt): a real Claude Code turn on squire (model haiku) was asked about its usage. It called `read` with `{"facet":"usage"}`, which was served by an isolated migrated server holding the captured event, and it answered from the result. The running helper was not changed. Script: `.scratch/usage-tool-proof.mts` (not committed).

## Rendered states (mock r7)

Start `node apps/mobile/scripts/render-consolidated-board-proof.mjs` and open `http://127.0.0.1:4179/?view=profile&usage=<state>`. Use `view=usage-members` for Members and `theme=light` for Bone.

| r7 state | Screenshot |
| --- | --- |
| Section fix: ACCESS header, one left edge, even spacing | [Full profile](profile-full-dark.png) / [Bone](profile-full-light.png) |
| A. Claude Code, normal | [normal](profile-normal.png) |
| A. 80% or more (brass) | [warning](profile-warning.png) |
| A. Stopped by provider (red, back time) | [stopped](profile-stopped.png) |
| A. Old data (brass bottom line, numbers stay) | [old](profile-old.png) |
| B. Free agent, normal | [free](profile-free.png) |
| B. Free agent at 80% or more | [free-warning](profile-free-warning.png) |
| B. Free agents paused by the shared budget | [free-paused](profile-free-paused.png) |
| C. OpenRouter key with no limit | [key-open](profile-key-open.png) |
| C. OpenRouter key with a limit | [key-limit](profile-key-limit.png) |
| C. Key limit at 80% or more | [key-warning](profile-key-warning.png) / [Bone](profile-key-warning-light.png) |
| C. Key limit reached | [key-reached](profile-key-reached.png) |
| C. Old data | [key-old](profile-key-old.png) |
| D. No source, with context | [no-source](profile-no-source.png) |
| D. No source, no context: no USAGE section | [none](profile-none.png) |
| Members: text only at 80%+, stopped or paused | [Members](members-dark.png) / [Bone](members-light.png) |

Native Android: boot an emulator with `beeline emulator`, install Expo Go SDK 55, run `npx expo start --go --port 8137 --lan` in `apps/mobile/usage-proof`, then open `exp://127.0.0.1:8137` after `adb reverse tcp:8137 tcp:8137`. See the [screenshot](android-usage-cell.png) and the [accessibility hierarchy](android-usage-cell.xml), which shows each column as a progress bar with its reset time.

No release was dispatched. The production check after release remains with the reviewer.
