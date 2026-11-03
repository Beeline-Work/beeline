# Group E: server/helper/provider ownership follow-up

Base: `e22ad688e` on `fm/network-ops-fixes-combined`. Router activation remains
default-off. No supported-version floor, removal hold, assertion, budget,
network manifest or CI/security gate changes. This is a pre-switch correction,
not whole-finding closure or rollout acceptance.

## Gaps corrected

- **F16/F22 — retired leader-cycle admission.** `BackgroundLeader` supplies the
  existing connection owner's abort signal to the production `BackgroundWork`.
  Loss or stop drains the admitted callback but prevents admission of later
  families under that retired owner. The real PostgreSQL
  `background-leader.postgres.test.ts` case `ends admission for the rest of a
  repair cycle when its physical backend is lost` terminates the actual lock
  backend while the first callback is held. Before: the later repair runs.
  After: it does not; a fresh epoch still runs its initial family pass. This
  does not fence an already-entered provider or transaction's commit.
- **F17 — exact input generation across setup awaits.** The actual
  `VoiceRoomRuntime.listen` rechecks its track generation after authorization
  and participant reads, before another setup read/provider. An old missing
  membership result cannot stop a replacement microphone. Late raw frames and
  obsolete pump failures also remain with their originating input. The two
  `replaced input cannot continue` cases in `voice-room-runtime.test.ts` run
  with both local doubles and actual PostgreSQL participant SQL. Before: the
  authorization case adds three stale reads; the membership denial stops the
  successor. Both regressions pass after the fix. RTC/STT remain doubles;
  physical provider/native execution is not claimed.
- **F19 — selected stream construction cannot restore growing snapshots.**
  `HelperOverlayChannel` retains selection independently of transport
  availability. A stream constructed after registration loss stays on that
  path and publishes no legacy draft/retraction. Selected streams require
  their already-claimed command/generation. `helper-overlay.integration.test.ts`
  retains the real MachineLink/AgentChannel adapter and old-server behavior;
  its three new cases failed before this correction. Legacy full snapshots
  remain held until the installed-helper compatibility floor.
- **F21 — persistence completion belongs to its original share lease.**
  `SquireShareRenewals` checks its exact lease object after awaiting persistence.
  An old false result cannot cancel a newer explicit share. Both old result
  variants are covered in `squire-share-renewals.test.ts`; false failed before
  the fix. `computer-expiry.test.ts` composes that owner with the real
  `refreshComputerSession` SQL on PGlite and PostgreSQL, proving the replacement
  renews the durable share. The external Squire transport is a double.

## Disposition of every assigned finding

| Finding | Closed gap / executable evidence | Still open, exact boundary |
| --- | --- | --- |
| F12 | Existing actual registration/receipt candidate proof retained. | `bindOwnedModelTurn` and `createOwnedModelPiExtension` still have test-only callers; installed Body generation credential/configuration composition is absent. `owned-model-proof.md` lists the unselected adapters. Legacy freshness retirement remains held for the helper floor. |
| F13 | Existing PostgreSQL replay/coordinator candidate proof retained. | `router-group-c-replay.postgres.test.ts` deliberately replaces `PhoneService.buildRouterValue` with a synthetic builder. It cannot establish complete source/decorator CPU/p95 and coordinator/final-fence workload non-regression. No claim that the bounded Room cost proof covers every family. |
| F14 | Existing targeted actual-socket and durable inbox-adoption candidate proofs retained. | `daemon-live.ts` retains the supported message/inbox compatibility lane alongside command-only negotiated subscriptions. Full historical source/helper composition is not established by the targeted irrelevant-event test or local text adoption test. No retained compatibility ingress is deleted here. |
| F15 | Existing PostgreSQL member-stream proof retained. | Explicit `pollOnce` remains in `apps/body/src/session-join/bridge.ts`; installed older bridges/member-stream floor are not established. Its removal is explicitly held by readiness. |
| F16 | Retired-cycle admission corrected; actual backend-loss proof above. | An already-running family/provider still needs its own durable generation/current-authority effect fence; the cycle abort is admission only. `repairDeadlineFamilies` and production detached check-in composition are not universal effect/commit fencing. |
| F17 | Stale input setup/denial corrected; PostgreSQL input-source variants above. | Physical LiveKit/Flux events, all provider continuations and complete production accounting/takeover workload remain unproved; mocked RTC/STT must not be labeled external-provider execution. |
| F19 | Selected construction/drop downgrade corrected; real machine-channel proof above. | Legacy growing snapshots remain intentionally present in `AgentTurnStream`; removal requires the helper floor. Complete model/provider context lifecycle remains open as in F12. |
| F21 | Stale share-persistence result corrected; actual persisted share renewal proof above. | External payment-provider completion, installed warm/cold OAuth/native callbacks and actual Squire ceremony composition remain open. Synthetic HTTP/DB completion and provider doubles do not establish those cohorts. Unsupported status sources must remain UNKNOWN, never polling fallbacks. |
| F22 | Retired background-owner admission corrected; same PostgreSQL proof as F16. | The 55 D1/6 D2 inventory is classification, not complete physical vendor/SDK route/effect ownership. Generic helper dispatch, uninstalled owned model adapters and physical voice/provider continuations retain their existing open boundaries. |

## Shared files

`apps/server/src/index.ts`, `background-leader.ts` and `background-work.ts` change
only to propagate the existing leader signal into family admission.
`apps/body/src/turn-stream.ts` and `helper-overlay-channel.ts` change only the F19
selection/downgrade boundary; the F01 compatibility-removal hold is preserved.
The integrator's readiness and closure ledgers are not rewritten.

## Validation

All Vitest invocations use `--maxWorkers=2 --minWorkers=1`, one suite at a time.
PostgreSQL is an isolated worktree-local loopback cluster; each existing harness
creates and drops disposable databases/schemas. No production, owner Workspace,
helper lifecycle or real vendor operation was used.

The full voice runtime suite passes **268/268**, including two new real
PostgreSQL cases. Computer expiry/share composition passes **8/8** across PGlite
and PostgreSQL. Selected overlay adapter passes **5/5** and share renewal passes
**8/8**. The new actual leader-backend-loss proof passes with its full **3/3**
PostgreSQL suite. Additional serial regression/P-group results are recorded with
the delivery.

All eight workspace builds and the full root typecheck (including mobile and scripts) passed. Root typecheck initially encountered ignored
historical `apps/mobile/evidence/composer-hint-center/local/selectall/*.tsx`
snapshots included by the mobile glob. For the clean-tree check only, these
ignored local artifacts were moved inside `.scratch/group-e/` and restored
unchanged afterward; no tracked compiler configuration or source exclusion was
changed. Initial workspace errors from stale generated package declarations
were resolved by rebuilding the existing workspaces.
