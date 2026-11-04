# Group D native/client adapter composition

The router capability remains off. This is a pre-rollout adapter follow-up, not
whole-finding closure or an installed-native acceptance claim. The integration
base for this report is `1c559d844`. Existing rollout-readiness and closure-ledger
rows retain their authority; held compatibility removals stay held.

## Per-finding disposition

| Finding | Gap closed here and executable proof | Still open, with exact evidence |
| --- | --- | --- |
| F01 overlays | No premature removal. The existing P12 `helper-overlay.postgres.test.ts` proof passes (2 cases), covering hidden helper uploads, entry baseline and terminal fences. | The old full-draft Body path is held by the rollout-readiness row until the installed-helper compatibility floor is established. This task supplies no installed floor and does not delete that path. |
| F07 history/tools/previews | Generic socket requests can no longer dispatch owner-only tool and media reads. The P4 socket proof rejects those bypasses before wire dispatch. The P8/P11 media proof now calls the real `artifactImageSource`, `fetchArtifactBytes`, `artifactLocalUri` and `openArtifactInBrowser` adapters. Preview/view/save share one metadata read and one HTTP byte transfer; a runnable capability reuses that metadata. `media-demand-owner.test.ts` proves browser metadata/link opportunities are consumed once. | Generic history remains open: `RoomViewClient.history/historyAfter/historyAround/outline` in `sync/transport/room-view-client.ts` still call its generic reader, and `room-message-store.ts` still offers automatic short-list fill. This follow-up does not claim those readers have router ownership. Installed parse/render and complete history/tool/preview cohorts remain required. |
| F10 foreground | The existing real WebSocket/PostgreSQL P4 proof now enters through production `sharedLiveConnection`, including its NetInfo configuration and callback deduplication. Same-type Wi-Fi IP changes now count as path edges; initial/duplicate samples do not. Healthy callbacks execute zero queries and zero socket replacements; one half-open incident replaces once and recovers only the demanded Room. | NetInfo native events and AppState are synthetic inputs to the real adapter. Actual installed OS/path flapping and the remaining supported-platform callback matrix remain unproved. |
| F11 auth/OTA | GitHub and Google completion inspections are shared across warm/cold adapters for the same origin/state/recovery token. Google native picker results and fallback cannot complete or restore a replaced ceremony. Cancellation during recovery of a lost native completion response also rejects the recovered token and burns the committed ticket. P9 in `router-group-c-connection.postgres.test.ts` composes both actual preauth clients, HTTP, independent PostgreSQL pools, `AuthStore`, durable ticket capture and LISTEN: two callback adapters make one held HTTP request, inspect once while pending, inspect once on commit, and make no timed repeat. An additional P9 case commits a native ticket, drops its completion response, pauses the independent PostgreSQL recovery read, then cancels: no token/browser fallback returns and the durable ticket is consumed exactly once. Provider session tests cover cancellation, failed-held recovery, duplicate cold callbacks and late native picker success/refusal. | OS/browser callback delivery and the HTTP response serializer remain synthetic seams in P9. OTA behavior is unchanged: `update-provider.ts`/`useUpdates.ts` retain their shared SDK flight and connection quotas; installed Expo cold pre-socket/resume behavior and native retry capture remain open. Source `checkAutomatically: NEVER` alone cannot prove installed behavior. |
| F18 SDK/backoff | P4 now exercises production NetInfo path-edge ownership and its disabled HTTP reachability fallback through real sockets/PostgreSQL. The Google native callback fence prevents late results from issuing a completion or browser fallback after replacement. Existing `livekit-owned.test.ts` exercises private copies of both installed SDK distributions, one signal join and no region failover/retry over an idle day. | This is not an all-vendor retry sweep. Installed `expo-updates` 55.0.26 source retains native full-asset fallback requests in Android `loader/FileDownloader.kt` and iOS `AppLoader/FileDownloader.swift`. No wrapper-only proof closes those internals or older installed binaries. Actual native flapping and remaining vendor/SDK egress capture remain required. |
| F23 files/links/favicon | The installed media adapter now carries its reader/origin; signed-link and playable-artifact paths use the existing shared metadata flight. Browser gestures admit metadata plus the link synchronously. Current metadata is checked again after the capability reply, so navigation, disconnect or revoke cannot return a stale URL. P8/P10/P11 proves actual preview/view/save adapters, demand-only expiry refresh and no external-browser launch when authority is revoked after link enqueue. Metadata unit tests also cover link/play joining and navigation/disconnect fences. | Metadata/link/play legacy HTTP deletion stays held until the switch, as the rollout-readiness row requires. Native storage/hash leaves in this PostgreSQL composition remain synthetic; installed full-screen native flows and complete external sandbox egress remain unproved. Existing bundled/server-owned AppMark behavior is retained; no favicon channel is added. |

## Scope and reproducible validation

Shared implementation changes are limited to
`packages/net/src/private/admission.ts` and `media-demand-owner.ts`: the existing
browser-file action admits its metadata child in the same synchronous gesture,
matching the existing playable-file action. There are no new network sites,
registry operations, UI, budgets, security/validation/CI gates or rollout switches.
`router-owner.ts` only binds the existing media adapter to its reader and origin.
Other changed production files belong to this group's auth, transport and media
adapters. Fixture updates provide the media adapter's reader/origin.

Run Vitest serially, one suite at a time, with `--maxWorkers=2 --minWorkers=1`.
PostgreSQL proofs require an isolated loopback URL in
`BEELINE_COMMAND_TEST_POSTGRES_URL`; no production or owner Workspace is used.

- Mobile session/transport/media/SDK regressions: provider session suites,
  `useUpdates.test.ts`, `live-connection.test.ts`, `media-cache-connection.test.ts`,
  `artifact-byte-owner.test.ts`, `artifact-link.test.ts`, `ArtifactMedia.test.tsx`,
  `router-owner.test.ts`, `livekit-owned.test.ts`, `voice-transport.test.ts` and
  `ActivityTimeline.test.tsx`.
- Integrated auth/recovery boundaries: `monolith-session.test.ts`,
  `session-required.test.ts`, `room-draw-barrier.test.ts`,
  `room-view-client.test.ts` and `monolith-rig-transport.test.ts`.
- Shared core: `packages/net/src/media-demand-owner.test.ts`.
- Inherited timer-fix regressions: `helper-overlay.test.ts`,
  `room-scheduled-work.integration.test.ts`, `tray-committed-clock.test.ts`
  and `voice-cutin.test.ts`. Their assertions and deadlines stay unchanged.
- Existing P-group PostgreSQL harnesses:
  `router-group-c-connection.postgres.test.ts` (P4/P9),
  `router-group-c-media.postgres.test.ts` (P8/P10/P11),
  `helper-overlay.postgres.test.ts` (P12), and
  `router-group-c-completion.postgres.test.ts` (P7/P9/P12).
- Strict F07 payload proof: `node --import tsx scripts/prove-router-group-c-room-payload.mjs`.
- Full root `npm run typecheck`, `npm run lint:phone-network`,
  `npm run lint:router` and unchanged
  `node --test scripts/network-codec-bundle.test.mjs`.

Observed on the integrated worker source: **421 mobile regressions in 17 serial
suites**, **11 shared-core cases**, **34 inherited server timer regressions in four
serial suites**, and **13 real-PostgreSQL cases in four serial suites** pass.
The strict 200-tool payload proof passes: initial tool rows 0,
initial value 1,970 bytes, expanded rows 200, explicit full output 32,768 bytes,
and revoked enqueues 0. Full root typecheck, both scanners and all three bundle
gates pass. Auth/native event and serializer seams remain as described above.

The measured phone owner is **86,512 raw / 24,506 gzip bytes**, within the unchanged
90,112 / 24,576 limits. The phone manifest remains 72 sites and the router scanner
158 legacy boundaries. Passing named local proofs does not close any whole
finding or authorize activation.

The correction from `5a3dd9632` to `1c559d844` changes only MCP fixtures and
documentation. After merging it, `rooms-mcp-negotiation.test.ts` passes all four
cases with the production OAuth constructor and the original HTTP 409 and
zero-query assertions. The preceding 479-case selection remains applicable to
the unchanged production source.
