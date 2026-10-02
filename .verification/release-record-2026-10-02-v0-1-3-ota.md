# Release record — v0.1.3 (OTA) — 2026-10-02

Scheduled 2:00 AM ET release run (schedule `213bcf80`, Daily 2:00 AM EST release).

## Outcome

- Run: https://github.com/Beeline-Work/beeline/actions/runs/36971658280 — completed **success** (06:34:52Z).
- Dispatch: `selection=auto`, `store_track=none`, `allow_pin_restore=false`, `plan_only=false`.
  An earlier delivery of this same schedule already dispatched it at 06:02:31Z (workflow_dispatch, actor beeline-app[bot]);
  it was active when this turn woke, so **no duplicate was dispatched**.
- Identity: **v0.1.3 @ `61161f60833c29f7d9ca8238a8a95d533e0b2de5`** (current `origin/main`).
  Plan artifact `unified-release-plan-v0.1.3-61161f60833c29f7d9ca8238a8a95d533e0b2de5`.
- Plan selected: server, helper, mobile-ota, desktop, website. Carried: mobile-native `v0.1.2@038ebe856f`.
  Runtime pins unchanged (android 33 / ios 32) → no native store binaries required, hence `store_track=none`.
- Job results: initialize, server, helper, mobile_ota, website, desktop (icons + all three builds),
  desktop_checkpoint, release_result all success. mobile_native_android/ios, server_deploy_plan,
  desktop "Detect changes", release_proof, retry skipped as expected.
- Timings: OTA elapsed 1493s; whole run 1903s; SLOW=false; budget 20 min; soft limit 2700s.

## OTA promotion (verified from run evidence)

- Promotion action outcome success (62.3s). Promotion artifact
  `mobile-ota-promoted-v0.1.3-61161f60833c29f7d9ca8238a8a95d533e0b2de5`.
- `release_version=v0.1.3`, `source_sha=61161f60833c29f7d9ca8238a8a95d533e0b2de5`.
- Republished; production groups = 17 targets:
  `release_targets=android@33,android@23,android@24,android@25,android@26,android@28,android@29,android@31,android@32,ios@23,ios@24,ios@25,ios@26,ios@27,ios@29,ios@31,ios@32`.
- `production_groups=android=e9920a2d-b9ec-4be9-959a-4f890c32fab5,ios=561fac90-ccc2-4310-b5cc-ef05e973827a`.
- `listed_production_targets` / `listed_production_groups` read back and match the promoted set.
- Delivery index artifact: `mobile-ota-delivery-index` (ID 11213000537).

## Rest of the release

- Server: live at `v0.1.3` — `https://server.usebeeline.app/version` →
  `{"version":"v0.1.3","sourceSha":"61161f60833c29f7d9ca8238a8a95d533e0b2de5"}`; `/readyz` HTTP 200.
- Helper: built + promoted (`checkpoint-helper-promoted.json`, linux-x64 / darwin-arm64 / darwin-x64).
- Desktop: linux-x86_64, windows-x86_64, macos-universal installers built.
- Website: built/published.
- Store submission: **none** — native platforms skipped (pins unchanged, `store_track=none`).
- Release record delivered: `gh release list` → **v0.1.3 Latest** (2026-10-02T06:34:36Z).
- Notification: `NOTIFICATION_STATE=sent`, `NOTIFICATION_DETAIL=server returned HTTP 200`.
- Device proof: **UNPROVEN** — `release_proof` skipped (opt-in, not requested).

## Corner state

- No code changed, committed, pushed, or merged. `feature/corner-9a995687e22f` unchanged.
- This record is kept untracked like the other release records.
- Reliability metric printed by the run: rate 57.9% (11/19 rolling attempts) vs the <10% target — recorded, not a gate.
