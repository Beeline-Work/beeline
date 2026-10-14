# Why Beeline storage kept growing

Investigated on **squire, 2026-10-14**, with the live helper at **v0.1.57**. The
helper was never stopped, restarted, updated or otherwise driven. All host
inspection was read-only. No host storage was deleted. Removal proofs use
throwaway test directories and the repository's isolated test environment.

The approved cleanup policy was implemented incompletely. Release pruning did
not exist. Cleanup could repeatedly fail on immutable downloaded directories;
several legacy layouts were invisible to the sweep. Whole-cache expiry let one
recent file pin gigabytes. Cleanup also mistook a Squire *skill* for a vault,
required Room access after archival, and had no working macOS implementation.
These are implementation failures, not a need for another confirmation gate.

## Measurements and evidence

`du -sx` measured allocated KiB during this investigation. The second column is
the earlier measurement supplied with the task; the third is this live snapshot.
These are distinct readings of an active machine. Totals and hardlinks can vary
while other work runs; the table does not claim every byte is disposable.

| Bucket | Earlier measurement | Investigation snapshot (GiB) |
| --- | ---: | ---: |
| `~/.local/lib/beeline-releases` | 35 GB / 300 versions | 34.39 / 300 directories |
| `~/.local/state/beeline/deleted-runtimes` | 4.8 GB | 4.79 |
| `~/.local/state/beeline/agents` | 83 GB | 86.23 |
| `~/.local/state/beeline/corners` | 47 GB | 68.72 |
| `~/.local/state/beeline/repositories` | 22 GB | 21.69 |
| `~/.local/state/beeline/room-checkouts` | 5.7 GB | 5.70 |
| `~/.local/state/beeline/npm-cache` | 5 GB | 4.91 |

I ran `journalctl --user -u beeline-helper`, `beeline storage --dry-run` and
`beeline storage --orphans`. The shipped dry run reported **3.05 GB eligible**:
2.15 GB of archived private Room storage and 0.90 GB of retired-runtime storage.
The orphan report identified **60 folders**, but reported 13 legacy checkout
folders without owner records and eight private folders without settled lifecycle
answers. The dry run also failed to inventory one large Room with
`stdout maxBuffer length exceeded`. This explains why the reported eligible
bytes were much smaller than the occupied storage.

## Old helper releases: no retention code was wired

`stageRelease` created a new release directory; `activateRelease` switched the
active symlink and preserved displaced installations. Neither function nor
machine startup pruned old release directories. Keeping a previous version was
therefore effectively keeping *every* previous version. The active anchor was
`beeline-releases/35b5d03b3cca47ba9dc2fe0fc33ceac6a6385509` and its parent held
300 release directories.

**Fix:** record the displaced version, prune under the install lock after
activation and on helper startup, and retain only current plus one previous
version. A verified staged version and a still-loaded predecessor are temporarily
protected during handoff. Historical symlink litter is unlinked without following
its target. Startup repairs installations that predate rollback metadata.

## Deleted runtimes: permissions failure plus excluded legacy names

The truncated journal entry was not an unexplained `[Er`: it was **EACCES**.
At 14:42:23–24 the helper failed to remove three downloaded
`React Native DevTools-linux-x64` trees in two retired-agent tombstones. Their
directories were mode **0500**, owned by the helper's Unix user. Recursive `rm`
needs writable directories to unlink their children; retrying the same command
cannot succeed. `reclaimWholeStorageObject` logged the error and continued, so a
successful maintenance pass could still leave those bytes behind for another six
hours. Private Room cleanup hid the specific error behind “inventory, login or
removal did not settle.”

The name filter additionally accepted only `<64 hex>-<13 digit timestamp>`.
This machine also has `orphan-20260904-<64 hex>` and `husk-<64 hex>` directories,
which were never candidates regardless of their age or contents.

**Fix:** recognize all recorded retired-runtime layouts; make only owned
directories inside an eligible disposable object writable before removal. Never
follow links or modify Squire stores. Repairing first also avoids a macOS failure
seen in native CI: recursive removal rejected on EACCES while sibling removals
continued, so the subsequent repair inventory failed on a disappearing `codex`
directory with ENOENT and left the remaining read-only video frames behind.
Surface actual errors, keep deferred authority, and run ended-owner maintenance
without waiting for every unrelated Room on the machine to become idle.

## Agents and private Room homes: cache granularity and inventory failures

One private `agent-home/video-build` measured **415 MiB** in this snapshot. The
private storage sweep treated an unknown directory or a known cache as a whole
object: every descendant and the directory itself had to be unused for seven
days. Creating or reading one frame/download therefore preserved all old siblings.
A protected token under a cache could likewise preserve unrelated downloads.
Archived homes were wired for immediate removal, but hit the same read-only
DevTools removal failure described above. Large inventories used one JSON result
with a 128 MiB output cap; the live dry run exceeded it for Room
`bb91a1c7-7cad-4fde-aafc-94fccb651ac8` and retained that Room. Eight private folders were absent from successful lifecycle
inventories; the old sweep skipped those folders entirely, so their disposable
files had no seven-day expiry path.

**Fix:** expire disposable private files independently after seven days, keeping
credentials, browser profiles, settings and local transcript/resume objects for
open Rooms. Keep database sidecars together. On confirmed archive remove all
non-Squire private storage immediately; server messages keep the transcript.
Apply seven-day expiry to disposable files in unlisted private folders too,
without inventing an archive or removing their credentials/history. Failed
lifecycle reads still retain storage. Stream Linux inventory records rather than
cap one huge result. Permission repair
is shared with retired-runtime cleanup.

## Corners: a false Squire match and archive access that could never return

For corner `2febadbb-0554-4152-bae0-b67d3c6e7c0f`, the path that triggered
“refusing checkout containing Trusty Squire storage” was **`skills/trusty-squire`**.
It contains the repository's skill code, not the host vault. The exclusion matched
any path segment named `trusty-squire` and rejected the entire checkout. The same
failure appeared repeatedly for corner `632cffa8-e94c-49c3-a5c4-661b1f0277c6`.

The “cleanup refused; local work kept” records on this machine carry **403,
`daemon room access denied`**. Several agents have 89–92 such durable refusal
records. Reaping required `getCornerRestoreState`/a parent Room GitHub token;
archived former members could not obtain them. The permanent-refusal marker then
prevented retries across helper restarts, even though bootstrap still supplied
an affirmative archive fact. The generic archived checkout sweep considered
only `room-checkouts`, not `corners`.

“Local work kept” was protecting the complete checkout and local refs from
cleanup without Room authority. A separate publication check also protects
tracked/untracked changes and commits not recoverable from origin. The message
was **not evidence that those 403 corners contained unpublished work**. Squash
merges add another false refusal: the accepted PR head need not be an ancestor
of the resulting `origin/main` commit after the feature branch is deleted.

**Fix:** distinguish Squire skill source from actual stores. Persist confirmed
archive facts in local checkout ownership and clean all archived checkout kinds
without requiring new Room access or deleting remote branches. Bootstrap supplies
the exact head of a confirmed landed PR, so a clean matching local head can be
removed after a squash merge. Remove the exact accepted local branch and stale
worktree registration too, so neither pins the bare clone. Actual dirty or
unpublished work keeps the existing publication protection; generated scratch
continues to be reclaimable, using the same repair for read-only generated output. No confirmation or new safety gate is added.

## Repositories: blocked corners, overbroad publication checks and invisible layouts

Bare clones remain while Git registers linked corners; corner retention therefore
pins their shared object databases. The old guard also required each local branch
to **equal** its corresponding origin tip. A perfectly published older ancestor
failed that comparison when origin advanced. `git fsck --unreachable` treated old
unreferenced commit objects as permanent local work.

The sweep visited only 24-hex `.git` names. This host also has legacy regular
clones named `github-<repository id>-<12 hex>` and `<64 hex>`, plus the old
`repositories/.beeline-corners` checkout tree. That last tree measured **11.90
GiB**, and `github-1327312394-5c59c9a14ede` measured **5.58 GiB**. Read-only Git
inspection confirmed the legacy clone heads are contained in origin refs.

**Fix:** reap archived worktree registrations and their accepted local branches;
recognize published ancestors rather than require tip equality. Unreferenced
objects alone cannot pin an unused clone forever. Expire the recognized legacy
code-copy layouts, including nested corner groups and warm-pool slots, under the
seven-day rule with publication checks, protecting
live linked worktrees and actual unpublished branches.

## Room checkouts: no owner, no sweep

The old expiry pass required a recorded/discovered Room owner. The live report
identified **13** checkout directories it could not map to one. Those directories
had no other expiry path, so “unknown owner” meant indefinite retention. Owner
lookup can also fail when the legacy hash's original branch is no longer among
origin refs. Archived copies remained subject to the broad Squire exclusion.

**Fix:** recorded archive owners retain immediate cleanup authority. Otherwise,
a legacy code copy can expire after seven days without inventing an archive fact,
provided its working tree is clean and its head is recoverable from origin. Real
unpublished work remains protected. Include these candidates in the read-only
storage report as unused code copies.

## npm cache: one fresh package kept the entire store

`pruneMachineStorage` treated the full `npm-cache` directory as indivisible. A
single recent package, log or parent-directory access prevented deletion of any
old blob in the 4.91 GiB cache. The host-wide sweep also required all scheduler
sessions to be absent, including idle retained sessions, which could starve
maintenance on a busy multi-agent machine.

**Fix:** expire old npm content/index/log files independently of recent siblings,
using each file's newest access/modification time. Apply the same rule to turbo
cache entries. Keep model/tool generations intact. Fence new launches while
sweeping shared storage, allow existing sessions to continue, and check actual
process/open-file/mount use of eligible paths before removing them. Cache misses
are regenerated by the relevant package/build tool.

## macOS would otherwise retain everything

`capturePrivateProcessUse` returned “in use” for every path outside Linux;
`hasMount` returned true outside Linux. Inventory also depended on Linux-only
`O_NOATIME`/`O_DIRECTORY` flags and `/usr/bin/python3`, which cannot be assumed on
a fresh MacBook. Thus the shipped cleanup tests could pass on Linux while macOS
could never remove eligible storage.

**Fix:** use Node filesystem inventory on macOS, `lsof` for actual process/open-file
use and `mount` for mounted descendants. Normalize the OS-owned `/var` and `/tmp`
aliases to `/private`; continue rejecting agent-controlled directory aliases.
Apply that same normalization to Git worktree and common-directory comparisons:
native Mac regression tests exposed Git returning `/private/var/...` while Beeline
held `/var/...`. The self-worktree was misidentified as another live checkout,
retaining both bare and legacy clones. The common-directory containment test also
failed, retaining accepted local branches after their checkout had been removed.
Unusable OS evidence still retains storage rather than guessing. No lifecycle
action is required for inspection.

## Regression evidence

`storage-bloat.regression.test.ts` exercises byte removal for every bucket,
including read-only retired downloads, legacy layout names, stale video frames
beside recent ones, exact rollback retention, access-refused/squash-merged corners,
legacy Room/repository copies, bare-clone ancestry and mixed-age npm cache files.
It also proves removal of a linked corner's accepted local branch lets the shared
bare clone expire. `helper-storage.darwin.test.ts` exercises the macOS path, open
file/mount protection, missing evidence and symlink behavior. The inventory pipe regression exceeds the old 128 MiB cap. The existing native
Mac acceptance job also runs the storage regressions. Existing tests retain
credential, transcript, unpublished-work, Squire and lifecycle coverage.

The initial ten new regressions all failed against the original implementation;
they passed after the fixes. Validation results are recorded in the PR. The
installed helper and host payload directories remain untouched; a normal release
delivers the repair.
