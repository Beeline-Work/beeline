# Corner checkout and adb ownership proof

Brief revision 1 binds this fix to `emu-1` and `checkout-1`.
Baseline: `4faae4a5dfb7671386ef7989606232c613123bcc` (main when this corner started).

## Reproduction emu-1

The reported event named emulator-5574 and its dedicated adb server 5576,
while the agent's default server had no devices. The previous fix installed a
record-aware adb launcher, but the corner's granted-command policy explicitly
removed PATH from the Android shell bindings. A sanitized host command could
therefore bypass that launcher and retain the per-agent server from before boot.

The event-shaped regression in `monolith-corner-turn.test.ts` prepares a shell
before boot, writes the kept record for emulator-5574/server 5576, obtains the
real corner grant policy, and executes plain `adb devices` in the command's
sanitized environment. Its SDK stand-in returns a device only on server 5576.
On baseline it returned only `List of devices attached`; with the fix it also
returns `emulator-5574\tdevice`. This assertion failed before changing the policy.

The original reports are historical; their exact guest process is not a safe
live target. The fixed-port regression preserves the reported wiring, and
`node scripts/prove-corner-adb.mjs` supplies real installed-SDK proof. It boots
two throwaway guests through the built helper, captures each real corner grant
policy, and runs plain `adb devices` through that policy before refreshing the
turn environment. On squire it returned only emulator-5562 on server 5564 for
one corner, and only emulator-5566 on server 5568 for the other. Restored turns
also selected the same serial and private server. Both guests and their servers
were released after the proof. No production guest was stopped.

## Reproduction checkout-1

The turn-loop regression starts two independent agent loops against the same
checkout while the first owns an uncommitted build input. On baseline, the
second harness started too. With the fix it receives a failed turn receipt
before harness activation or branch synchronization; the input stays intact.
A second variant keeps ownership after end_turn until the first agent's pushed
background-build completion arrives.

A real-Git regression also reproduced the destructive handoff: another clone
pushed an edit to a file with uncommitted local work, and branch sync returned
`realigned`, discarding that local work. With the fix it refuses synchronization
with an uncommitted-work reason and retains the exact input bytes. Clean remote
fast-forward, rebase and conflict realignment behavior remains covered.

`node scripts/prove-corner-checkout.mjs` exercises the built helper against a
throwaway real Git repository. One child process owns the checkout and writes
an unfinished input; a competing writer is refused. Killing the owner permits
a successor to enter immediately, and a peer push still cannot overwrite the
unfinished input. A separate process regression covers symlink aliases,
SIGKILL recovery and release after a thrown turn.

## Validation

- `npm run corner:prepare`
- `npm run typecheck` (workspaces, mobile and scripts)
- Body suites: monolith corner turns, checkout lock, branch sync, emulator
  lifetime, emulator leases, kernel locks, grant runner, ACP background tools
  and session scheduler
- `node scripts/prove-corner-adb.mjs`
- `node scripts/prove-corner-checkout.mjs`
- `npm run lint:workflow-paths`
- `node scripts/check-dead-code.mjs`

The checkout lock is local to the canonical worktree path; separate machines'
independent checkouts continue sharing accepted work through the remote branch.
A contender is refused rather than left waiting behind another editing turn.
The kernel releases ownership when the helper process dies; detached harness
tools retain it until completion or teardown. The adb change forwards the
existing lease launcher PATH through granted commands and leaves corners
without Android lease bindings on their existing command environment.
