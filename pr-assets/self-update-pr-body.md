## Daemon self-update path

Closes the stale-daemon problem: a Beeline daemon previously ran whatever bundle was installed at install time forever. Tonight that left an agent (Ox) serving an already-fixed bug from an obsolete bundle, unable to heal itself — correctly, because replacing `~/.local/lib/beeline` is outside the Room's read-only boundary. This gives **the daemon** a trusted self-update path; no agent write scope is widened.

### Read-only boundary: unchanged

`apps/body/src/bwrap-sandbox.ts` and the Room's write scope are untouched. Only the daemon process itself touches the install prefix, on its own schedule.

### Design

**Seam first (the dependency).** The `beeline-cli-publish` companion task has **not merged to `main` yet** (verified before opening this PR: no such PR is open, and `origin/main`'s `relay-stack/web/dl/manifest.json` still has the old shape without commit/version). Everything was therefore built against a locally served fixture manifest matching the described shape. All knowledge of the publisher's contract lives in exactly one file:

- `apps/body/src/self-update-manifest.ts` — `resolveManifestUrl()` (env `BEELINE_UPDATE_MANIFEST_URL`, default `https://usebeeline.app/dl/manifest.json`) + `parseUpdateManifest()` (maps manifest JSON → `PublishedBundle`). When the real contract lands, rebinding is a change to **that one file** and nothing else.

**Install layout / atomic swap.** After the first update, bundles live in `<prefix>/lib/beeline-releases/<releaseId>/` and `<prefix>/lib/beeline` becomes a symlink swapped by a single atomic `rename(2)` — there is no window in which the live install is half-replaced. The previous release is kept for rollback. Legacy installs (real directory, today's installer output) migrate on first activation; `<prefix>/bin/*` become stable forwarders into the symlinked bundle so they never change across releases.

**Identity reporting.** `bundle.json`, stamped with `commit` + comparable `YYYY.MM.DD` version by `scripts/build-beeline-bundle.mjs` and installed by `relay-stack/web/install.sh`. `beeline --version` and `Body`'s updater read identity from the *installed bundle*, never from a checkout (which may not exist on the host). Fallback when a pre-stamping bundle is installed: the daemon's own record of what it last applied.

**Safety.**
- sha256 mismatch aborts loudly and touches nothing (demo step 5).
- The new cli must pass a `--version` smoke test *before* it can win the symlink.
- A pending-update journal (`pending-update.json`) means "a daemon restarted onto this and must prove health within 5 min". Stale journal ⇒ automatic rollback at next start. Fatal supervisor error inside the window ⇒ rollback to the previous release + relaunch of it.
- A failed re-stage never deletes an already-verified/active release directory.

**Never restart mid-work.** Busy = any agent turn running anywhere in the daemon or an intake event in flight — reusing existing state (`runningAgentTasks` / `inFlightRequestIds`, the same state `channelTurnActive` trusts) via `Body.isBusy()` → `WorkspaceSupervisor.isWorkspaceIdle()`. No parallel notion of busy was invented. Download + verify + stage proceed while busy (they touch nothing live); only the swap waits for idle, polling up to 30 min (then deferring to the next tick, keeping the staged release).

**Surface.** Applied updates are announced into each served Room through the existing agent-message path (`broadcastDaemonNotice`) plus greppable daemon-log lines; `beeline update --status` shows installed identity / active release / last check / rollbacks / pending journal.

**Automatic vs opt-in.** Default-ON healing (6h cadence, 2 min startup grace), because opt-in would not actually solve the stale-daemon problem. `BEELINE_UPDATE_DISABLE=1` turns off only the *automatic* path; an explicit `beeline update` always works, and running daemons pick the swap up through their own busy gate via an update-request file — so even an operator-driven update can't interrupt work.

**Restart mechanics.** Handover spawns the replacement daemon from the ACTIVE release's `beeline-cli.mjs` via the existing `launchRuntimeDaemon`; foreground daemons stay attached to their terminal (stdio inherit, not detached). Paths Beeline supports today: backgrounded `beeline start` daemons (detached handover, pid file handed over safely) and foreground `beeline daemon` (attached handover).

### Proof

Full transcript: `pr-assets/self-update-demo-transcript.txt` (runnable via `node --import tsx apps/body/scripts/self-update-demo.ts`). Excerpt:

```
== 1. what is this daemon running? ==
installed bundle: {"commit":"aaa111old","version":"2026.01.01"}

== 2. agent work is running — the update must WAIT ==
staged: true, swapped: false, restart requested: false

== 3. work finished — swap atomically and restart onto the new bundle ==
active release: bbb222new  (previous kept: true)
room notice: Beeline bundle 2026.01.01 aaa111old -> 2026.02.05 bbb222new applied; the daemon is restarting now (previous release kept for rollback).
replacement daemon pid 3382716 came up as commit bbb222new

== 4. new bundle confirms healthy ==
journal cleared: true, pending now: undefined

== 5. corrupt/mismatched download aborts without touching the install ==
checksum mismatch for bundle.tar.gz: expected ffff…, got f8d4a3e1… — aborting without touching the installed bundle
installed identity still: {"commit":"bbb222new","version":"2026.02.05"}

== 6. an applied update that never starts is rolled back at next start ==
settle verdict: rolled-back; active release restored to: aaa111old
```

Tests (`apps/body/src/self-update.test.ts`, 12 passing): version/identity comparison (incl. deliberate indeterminate), manifest seam validation, end-to-end detect→download→verify→busy-wait→atomic swap→restart onto the new bundle (proving which cli came up via its own pid+commit marker), checksum rejection leaving the install untouched, stale-journal rollback + fresh-journal keep, single-rename rollback helper, and operator request honored despite auto-disable.

Pre-existing failures in `body.test.ts` ("per-agent model/effort persistence", 3 cases) fail identically on the unmodified base tree — unrelated to this branch.

### When `beeline-cli-publish` lands

Rebind the seam by editing `apps/body/src/self-update-manifest.ts` only:
- `DEFAULT_UPDATE_MANIFEST_URL` / `resolveManifestUrl()` — line ~37, if the published URL differs;
- `parseUpdateManifest()` — lines ~60–110, if field names differ (it already accepts both top-level `sourceCommit`/`version` and per-bundle `commit`/`version`).
Then re-run `npm test -w @beeline/body -- self-update` and the demo against the real URL.
