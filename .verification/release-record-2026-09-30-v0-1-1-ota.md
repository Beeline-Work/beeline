# Release record — v0.1.1 OTA (2026-09-30)

Owner request (Room message 5dd4aa5c7596566bf5c43eca90a4d23f7c219a870cef3c5dc8716bf33decf398):
"@candy Do another ota release"

## Run

- Workflow: Unified production release (`unified-release.yml`, dispatch on `main`)
- Run: https://github.com/Beeline-Work/beeline/actions/runs/36794919452
- Dispatch: 2026-10-01T00:11:36Z, `selection=auto`, `store_track=none` (OTA),
  device proof off, no allow_pin_restore, no recovery inputs.
- Identity: `v0.1.1@765d6e1ccd7282b7b26944f53b8a68840e9d40fd` (plan artifact
  `unified-release-plan-v0.1.1-765d6e1c…`)
- Supersedes: v0.1.0@076217de4a85c1d637dc72538049c4303839f856

## No duplicate

No unified-release run in flight at dispatch time (latest prior run
36730939779 completed success). Main moved 076217de → 765d6e1cc (18 commits
since the last release), so this head has no prior run; one dispatch issued.

## Plan rationale (OTA, not stores)

- Runtime pins unchanged between 076217de and 765d6e1cc: android 32 / ios 31.
- No mobile-native paths changed (no apps/mobile/android, ios, plugins,
  app.config.js, package.json).
- Therefore plan does not require native store binaries → OTA release with
  store_track=none, no store submission. Device proof opt-in, not authorized,
  default off; release recorded UNPROVEN per policy.
## Completion (verified 2026-10-01 ~00:49 UTC from run evidence)

- Run concluded `completed/success` at 00:47:36Z (~36m from dispatch).
- OTA promotion: delivery index artifact `mobile-ota-delivery-index.json`
  (run 36794919452) lists merge `765d6e1ccd…` state **published**, releaseVersion
  **v0.1.1**, 15 update groups, publishedAt 2026-10-01T00:38:11.614Z. Device
  confirmation null — proof off (opt-in, not requested); recorded UNPROVEN.
- Server: `https://server.usebeeline.app/version` answers
  `{"version":"v0.1.1","sourceSha":"765d6e1ccd7282b7b26944f53b8a68840e9d40fd"}`
  (built in job `server`, live after deploy/checkpoint).
- Helper: job `helper` success — daemon-leg build + "Publish the exact helper
  CLI package" + "Smoke the exact helper package and manifest" +
  `helper-promoted` checkpoint.
- Desktop installers: linux/mac/windows builds success. Website: success.
- `gh release list`: **v0.1.1 is Latest** (2026-10-01T00:47:27Z), superseding
  v0.1.0 / the v0.0.134 line.
- release_result job: outcome success, notification sent (HTTP 200),
  release record published (state delivered), NO_OP false.
- Store submission: none — `store_track=none`, mobile_native_android/ios and
  release_proof jobs skipped (runtime pins unchanged: android 32 / ios 31).
