# Agent Profile usage and empty-work indent (R1, R2)

## Reproduced

Android 36 emulator `buzzy_api36` on squire, 1080 × 2400 at 420 dpi. Baseline 3ae78f617.

- **R1:** open an owned agent's Profile with no merged PRs. "No merged work to show yet." starts at x≈16 dp. The RECENT WORK header and every row title start at x≈24 dp (see before-codex.png and before-cursor.png).
- **R2:** open an owned Codex agent's Profile and an owned Cursor agent's Profile with no usage snapshot. No USAGE section appears between Thinking level and Voice (same screenshots).

Production on 2026-10-20 matched this. Codex agents that ran since #2571 had only a context snapshot. Codex agents that had not run since, and every Cursor agent, had no snapshot.

## Raw adapter payloads (squire)

- codex-acp 2.2.2, the only usage update in a real session: `{"sessionUpdate":"usage_update","used":12967,"size":475000}`. The prompt result carries per-turn token counts. Plan rate limits stay inside the adapter and appear only in its `/status` text.
- cursor-agent `--print --output-format stream-json`, the `result` event: `"usage":{"inputTokens":18734,"outputTokens":21,"cacheReadTokens":0,"cacheWriteTokens":0}`. It has no plan limits and no context size.
- quota-axi 0.1.64 run in the agent's own environment reports both plans. Codex: weekly 53% left, 62,174 credits, plan pro. Cursor: included, auto, API and Grok Bot windows, plan Ultra. The recorded report is `apps/body/src/harness-quota.fixtures.ts`.

## Demonstrated

The after APK uses the same fixture. Message cycles through three agents:

1. after-codex.png: a Codex agent carrying the usage that `HarnessQuotaReader` produced from a real quota-axi read on squire. Columns: Weekly 48% (resets Sat 4:43 PM) and Credits 62,174 left. Note: "Codex · pro plan · updated …".
2. after-cursor.png: a Cursor agent from the same real read. Columns: Included, Auto, API and Grok Bot, two to a row so reset times stay whole. Note: "Cursor · Ultra plan · updated …".
3. after-nodata.png: a Codex agent with no snapshot. The USAGE section shows "Codex doesn't report usage to Beeline".

In every after screenshot, "No merged work to show yet." starts on the RECENT WORK header's edge.

The fixture (`apps/mobile/scripts/agent-profile-usage-native-proof.tsx`) mounts the production `AgentProfileView` with synthetic agent details and the recorded usage. It does not sign in to a live workspace.

APK SHA-256:

- Before: 8dd7d8d844b35e9813ac2485f11973fea9d1feb941873529531b122f34808752
- After: c75d44cd930c8cacce92f96cf00c43b4f4982c15f96a7d2e93fb34cb742f67a6

## Repeat

1. Run `npm run corner:prepare`.
2. From `apps/mobile`, run `npx expo prebuild --platform android --no-install`.
3. In `android/app/build.gradle`, set `entryFile = file("../../scripts/agent-profile-usage-native-proof.tsx")`.
4. In the generated manifest, set `expo.modules.updates.ENABLED` to false.
5. Build: `./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2`.
6. For the before APK, put the baseline `AgentProfileView.tsx` and `AgentUsageSection.tsx` in place first.
7. Install on the emulator and launch `app.usebeeline`. Scroll to USAGE and RECENT WORK. Tap Message to change the agent.
