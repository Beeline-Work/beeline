# Release record — v0.1.4 (OTA) — 2026-10-02

Human request in this corner: "@candy run an ota release". A run covering exactly that was already
active for current `main` when this turn woke (dispatched 17:05:03Z, actor beeline-app[bot]), so
**no duplicate was dispatched**; the active run was monitored to completion instead.

## Outcome

- Run: https://github.com/Beeline-Work/beeline/actions/runs/37038301757 — `workflow_dispatch`,
  completed **success** (delivery finishedAt 17:40:40.788Z; whole run 2122 s ≈ 35.4 min).
- Dispatch inputs, read from the run's own initialize log:
  `SELECTION: auto`, `STORE_TRACK: none`, `ALLOW_PIN_RESTORE: false`, `PLAN_ONLY: false`.
- Identity: **v0.1.4 @ `d76c270f55fac45fbfa22cbd43f8cced53eb7511`** = current `origin/main`
  ("Survive a kernel OOM kill of one harness child (#1989)").
- Plan artifact `unified-release-plan-v0.1.4-d76c270f55fac45fbfa22cbd43f8cced53eb7511`:
  selected = server, helper, mobile-ota, desktop, website; carried = mobile-native
  `v0.1.2@038ebe856fee8df7f3e014bdab68e17067646f2d`.
  `runtimePinChanged=false` (android 33 / ios 32 both before and after) → no native store binaries required,
  hence `store_track=none`.
- Job results: initialize, server, helper, mobile_ota, website, desktop (icons + macos/windows/linux builds),
  desktop_checkpoint, release_result = **success**.
  mobile_native_android/ios, server_deploy_plan, desktop "Detect desktop changes", release_proof, retry = skipped.
- Timings from the OTA leg: `parallel_candidate_wall=715 s`, `production_promotion=72 s`;
  run-recorded `durationSeconds=2122`. Not marked slow by the run's own classification.

## OTA promotion (verified from run evidence)

- Promotion step (`.github/actions/mobile-ota-leg`, step 6) → success; step 9
  "Refuse promotion unless the release proof succeeded" → skipped (proof not requested).
  Promotion artifact `mobile-ota-promoted-v0.1.4-d76c270f55fac45fbfa22cbd43f8cced53eb7511` (id 11242372976).
- `release_version=v0.1.4`, `source_sha=d76c270f55fac45fbfa22cbd43f8cced53eb7511`, status `production`.
- **17 production targets**:
  `android@33,android@23,android@24,android@25,android@26,android@28,android@29,android@31,android@32,ios@23,ios@24,ios@25,ios@26,ios@27,ios@29,ios@31,ios@32`.
- `production_groups=android=9ea920f7-7fed-47d7-935f-b9351b9b7995,ios=225bc7d1-26df-4aac-8f8c-0ff302de41a7`;
  `promotedAt=2026-10-02T17:32:16.547Z`.
- `listed_production_targets` / `listed_production_groups` were read back from EAS and match the promoted set.
- Previous production groups (superseded v0.1.3): `android=e9920a2d-b9ec-4be9-959a-4f890c32fab5,ios=561fac90-ccc2-4310-b5cc-ef05e973827a`.
- Delivery index artifact `mobile-ota-delivery-index` (id 11242203113), `updatedAt=2026-10-02T17:32:16.567Z`.

## Rest of the release

- Server: live at `v0.1.4` — `https://server.usebeeline.app/version` →
  `{"version":"v0.1.4","sourceSha":"d76c270f55fac45fbfa22cbd43f8cced53eb7511"}`; `/readyz` HTTP 200.
- Helper: built (darwin-arm64, darwin-x64, linux-x64 bundles) + promoted.
- Desktop: linux-x86_64, windows-x86_64, macos-universal installers built (`desktopVersion 0.2.52`).
- Website: built/published.
- Store submission: **none** — `store_track=none`, mobile-native carried, native jobs skipped.
- Release record: https://github.com/Beeline-Work/beeline/releases/tag/v0.1.4 — **Latest**, published 2026-10-02T17:40:36Z.
- Device proof: **UNPROVEN** — `release_proof` skipped (opt-in, not requested); the published attempt state records
  "mobile OTA promoted without a device proof; proof is opt-in and was not requested".
- Published attempt state: `state=delivered`, `terminated=true` (`machines-touched`) → no retry of this identity.

## Corner state

- No code changed, committed, pushed, or merged. `feature/corner-9a995687e22f` HEAD `4e1c7b1df` =
  `origin/feature/corner-9a995687e22f` (0 ahead / 0 behind).
- This record is kept untracked like the other release records.
