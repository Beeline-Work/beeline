# Usage truth and refresh (R-USAGE-2 to R-USAGE-6)

The approved mock shows five states of the Profile's Usage section in Bone and Obsidian. These captures show the production `AgentUsageSection` in each state.

## Reproduced

The reported divergence happened on squire agents, and chad can't reach their logins or the production database. Each reproduction is a test that was written first and run against the baseline (b94ca8ea2, with only the new contract types added and no behavior changed). Every one failed there:

- **R-USAGE-2:** Nerd read a Claude login an hour ago and Ruby reads the same login now. Nerd's Profile, Members row and `read_agent_usage` still showed the older numbers and stamp. (`agent-usage-accounts.integration.test.ts`)
- **R-USAGE-3:** a stale quota-axi report with `refreshedAt` three hours ago was stamped now and had no status. (`harness-quota.usage-truth.test.ts`, `agent-usage-accounts.integration.test.ts`)
- **R-USAGE-4:** a weekly window from three days ago plus a 5-hour window from now was stamped now. A window that quota-axi stopped reporting stayed in the snapshot. (`agent-usage-accounts.integration.test.ts`)
- **R-USAGE-5:** `refreshAgentUsage` returned nothing, both for an agent whose machine had no connection and for one whose helper answered. (`agent-usage-accounts.integration.test.ts`)
- **R-USAGE-6:** opening a Profile that had a cached copy never read the server. (`members.management.test.tsx`)

On the branch, every one of these tests passes.

## Demonstrated

### Live: two agents on one real Claude login (`live-proof.json`)

`scripts/prove-usage-accounts.mjs` runs the real server stack: PGlite, the NOTIFY listener, HTTP, and one helper WebSocket per agent. It also runs the real helper refresh code and real quota-axi reads of chad's Claude login. The two agents are Niglet and BBC, each with its own `CLAUDE_CONFIG_DIR` linked to one credential, the way Beeline agent homes are set up.

- Before: each agent had its own copy. Niglet showed 5-hour 31% as of 09:40, and BBC showed 7% as of 07:40.
- Helper start: one vendor read joined both agents to the account, and their numbers matched.
- One refresh, requested only for Niglet, returned `fresh` in 1.4 s, for 2 vendor reads in total. Niglet and BBC then gave the same numbers (5-hour 9%, weekly 29%, Fable week 0%) and the same stamp on the Profile, in the Members row and from `read_agent_usage`. The Profiles showed "Shared with BBC" and "Shared with Niglet".
- A refresh for an agent whose machine has no connection returned `offline` in 9 ms.

### Captures

`usage-truth-native-proof.tsx` mounts the production `AgentUsageSection` with Claude numbers that match the mock. Each state answers its refresh the way the server does in that case:

1. `1-fresh-*.png`: "Claude Code · max plan", "Shared with Jellybean and Nerd", "resets Sat … · updated …".
2. `2-refreshing-*.png`: these numbers are over 2 min old, so opening the section starts one refresh by itself. A native spinner fills the 44 px target, and the line reads "Refreshing · reading Claude on squire".
3. `3-read-failed-*.png`: muted numbers with the brass line "updated 9:02 AM · rate-limited, retrying …".
4. `4-signed-out-*.png`: "updated 9:02 AM · sign-in expired till next turn".
5. `5-offline-*.png`: "updated 9:02 AM · squire is offline".

**These captures were rendered in Chrome, not on Android.** Chad's user isn't in the `kvm` group (`/dev/kvm` is `nobody:nogroup` inside the corner), so the Android emulator won't start, even with `-accel off`. The stand-in is the same fixture entry, exported for web with `expo export --platform web` (react-native-web, the production unistyles themes and fonts). It was captured in headless Chrome at a 412 dp width and 2.625× scale.

The Android release APK of this fixture was built, but it couldn't be launched here:

- SHA-256: 8be90fe4825769c216b3398e4d5dad367f8237a4d14ef2d38c6ae47595ea54e7

## Repeat

- Tests: `npx vitest run src/harness-quota.usage-truth.test.ts` (apps/body), `npx vitest run src/agent-usage-accounts.integration.test.ts` (apps/server), `npx vitest run sources/components/buzz/AgentUsageSection.test.tsx "sources/app/(app)/beeline/members.management.test.tsx"` (apps/mobile).
- Live: `USAGE_PROOF_CLAUDE_CREDENTIAL=<credential file> node --import tsx scripts/prove-usage-accounts.mjs`.
- Android: follow `../agent-profile-usage/README.md` with `entryFile = file("../../scripts/usage-truth-native-proof.tsx")`. Tap "Next state" to move through the states and "Theme" to switch Bone and Obsidian.
