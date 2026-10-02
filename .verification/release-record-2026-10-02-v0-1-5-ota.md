# Release record — v0.1.5 (OTA) — 2026-10-02

Human request in this corner: "@candy do an ota release". No `unified-release.yml` run existed for
current `main` (`b4dfec78cc47ab11f6f12208c27a2c3ba8a7e6d9`) and none was in progress (last run
37038301757 covered `d76c270f` = v0.1.4), so a release **was dispatched** with the routine command
`gh-axi workflow run unified-release.yml --ref main` — no inputs, no PR list, no component selection.

## Outcome

- Run: https://github.com/Beeline-Work/beeline/actions/runs/37059928450 — `workflow_dispatch`,
  created 20:20:24Z, completed **success** 20:53:47Z (whole run 2003 s ≈ 33.4 min).
- Dispatch inputs, read from the run's own initialize log:
  `SELECTION: auto`, `STORE_TRACK: none`, `ALLOW_PIN_RESTORE: false`, `PLAN_ONLY: false`.
- Identity: **v0.1.5 @ `b4dfec78cc47ab11f6f12208c27a2c3ba8a7e6d9`** = current `origin/main`.
- Plan artifact `unified-release-plan-v0.1.5-b4dfec78cc47ab11f6f12208c27a2c3ba8a7e6d9`:
  selected = server, helper, mobile-ota, desktop, website; carried = mobile-native
  `v0.1.2@038ebe856fee8df7f3e014bdab68e17067646f2d`.
  `runtimePinChanged=false` (android 33 / ios 32 both before and after) → no native store binaries
  required, hence `store_track=none`.
- Job results: initialize, HELPER BUILD (darwin-arm64, darwin-x64), server, website, mobile_ota,
  desktop_installers (icons + macos-universal, windows-x86_64, linux-x86_64), helper,
  desktop_checkpoint, release_result = **success**.
  mobile_native_android/ios, server_deploy_plan, desktop "Detect desktop changes", release_proof,
  retry = skipped.
- Run-recorded classification: `outcome=success`, `NO_OP=false`, `SLOW=false`,
  `OTA_ELAPSED_SECONDS=1561`, `WHOLE_RUN_ELAPSED_SECONDS=1975`,
  `FIX_TO_PHONE_BUDGET_SECONDS=9000`, `SOFT_LIMIT_SECONDS=2700`.
- OTA leg stage timings (`mobile-ota-stage-timings.tsv`): `parallel_candidate_wall=712 s`,
  `production_promotion=66 s`.

## OTA promotion (verified from run evidence)

- Promotion action (`Promote the exact beta group to production`) → success, duration 65 335 ms.
- Promotion artifact `mobile-ota-promoted-v0.1.5-b4dfec78cc47ab11f6f12208c27a2c3ba8a7e6d9`
  (id 11250873427); ledger `status=production`, `delivery.state=published`,
  `delivery.builtAt=2026-10-02T20:44:39.776Z`, `delivery.publishedAt=2026-10-02T20:46:19.731Z`.
- **17 production targets**:
  `android@33,android@23,android@24,android@25,android@26,android@28,android@29,android@31,android@32,ios@23,ios@24,ios@25,ios@26,ios@27,ios@29,ios@31,ios@32`.
- `production_groups=android=ec084ea9-a6c8-499c-bec5-30924c9786ad,ios=e0e30e1e-5e29-45ef-9802-600ff52f4316`.
- `listed_production_targets` / `listed_production_groups` were read back from EAS in the same step
  and match the promoted set; `source_group_ids` (previous beta groups) are recorded in
  `mobile-ota-promotion-proof.txt`.
- Delivery index artifact `mobile-ota-delivery-index` (id 11250408846), `updatedAt=2026-10-02T20:46:19.752Z`;
  entry for `b4dfec78…` is `state=published`, `releaseVersion=v0.1.5`, 17 groups / 17 updates,
  `failures=[]`, `attempts=1` (owner device confirmation still pending, as usual without a device receipt).

## Rest of the release

- Server: live at `v0.1.5` — `https://server.usebeeline.app/version` →
  `{"version":"v0.1.5","sourceSha":"b4dfec78cc47ab11f6f12208c27a2c3ba8a7e6d9"}`; `/readyz` HTTP 200.
- Helper: built (darwin-arm64, darwin-x64, linux-x64 bundles), pages published, promoted,
  "Smoke the exact helper package and manifest" success.
- Desktop: linux-x86_64, windows-x86_64, macos-universal installers built (`desktopVersion 0.2.53`).
- Website: built/published.
- Store submission: **none** — `store_track=none`, mobile-native carried, native jobs skipped.
- Release record: https://github.com/Beeline-Work/beeline/releases/tag/v0.1.5 — **Latest**,
  published 2026-10-02T20:53:39Z; notification `sent` (server returned HTTP 200).
- Device proof: **UNPROVEN** — `release_proof` skipped (opt-in, not requested); the published attempt
  records "mobile OTA promoted without a device proof; proof is opt-in and was not requested".
- Published attempt state: `terminated=true` (`machines-touched`) → no retry of this identity.

## Corner state

- No code changed, committed, pushed, or merged. `feature/corner-9a995687e22f` HEAD `4e1c7b1df` =
  `origin/feature/corner-9a995687e22f` (0 ahead / 0 behind).
- This record is kept untracked like the other release records.
