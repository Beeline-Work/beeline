# Release record — v0.1.2 (2026-10-02)

Owner request (Room message 22ac24a865971d28621912cc1eea9d2361824322ab2b98f96a3579d3216fc5f6
and the follow-up "@candy run an ota release"): ship a release.

## Run

- Workflow: Unified production release (`unified-release.yml`, dispatch on `main`)
- Run: https://github.com/Beeline-Work/beeline/actions/runs/36957113893
- Dispatch: 2026-10-02T02:45:41Z, `selection=auto`, `store_track=production`,
  device proof off, `allow_pin_restore` false, no recovery inputs.
- Identity: `v0.1.2@038ebe856fee8df7f3e014bdab68e17067646f2d` (plan artifact
  `unified-release-plan-v0.1.2-038ebe856fee8df7f3e014bdab68e17067646f2d`)
- Supersedes: v0.1.1@765d6e1ccd7282b7b26944f53b8a68840e9d40fd

## No duplicate

A unified-release run was already active for current main when this turn began:
run 36957113893 (in progress, dispatched 02:45:41Z) exactly matched the pending
request, so no second dispatch was issued.

The immediately preceding dispatch attempt (run 36957021205, 02:44:30Z,
`store_track=none` OTA) failed initialize in 16s: the plan refused an OTA-only
release because the runtime pins moved (android 32 -> 33, ios 31 -> 32), which
requires either a store submission track or `allow_pin_restore`. `allow_pin_restore`
would assert a pin RESTORE whose runtime already has store binaries — not the case
here — and was not authorized, so the release ran as a full production release
(`store_track=production`), the standing choice for pin-changed releases.

## Completion (verified 2026-10-02 ~03:30 UTC from run evidence)

- Run concluded `completed/success`.
- OTA promotion: artifact `mobile-ota-promoted-v0.1.2-038ebe856fee...` reports
  delivery state **published**, releaseVersion **v0.1.2**, sourceSha 038ebe85,
  17 update groups, publishedAt 2026-10-02T03:23:13.576Z. Delivery index
  (`mobile-ota-delivery-index.json`) lists merge `038ebe856f…` state **published**,
  builtAt 03:21:34Z, 17 updateIds. Device confirmation null — proof off
  (opt-in, not requested); recorded UNPROVEN per policy.
- Server: `https://server.usebeeline.app/version` answers
  `{"version":"v0.1.2","sourceSha":"038ebe856fee8df7f3e014bdab68e17067646f2d"}`,
  `/readyz` 200.
- Helper: job `helper` success — daemon-leg builds (linux-x64 plus darwin-x64
  via `daemon-darwin-x64-v0.1.2-...`, darwin-arm64), CLI package publish,
  manifest smoke, `helper-promoted` checkpoint.
- Desktop installers: linux/mac/windows builds success. Website: success.
- `gh release list`: **v0.1.2 is Latest** (2026-10-02T03:28:31Z), superseding
  v0.1.1.
- release_result job: outcome success, release tag + notification sent
  (HTTP 200), release record published.
- Store submission (`store_track=production`, plan required native binaries):
  `mobile_native_android` success — local EAS production build (versionCode
  108 -> 109) uploaded to Play track `production` (`RELEASE_STATUS=completed`);
  `mobile_native_ios` success — local EAS production build submitted to
  TestFlight via altool (ascAppId 6803948500). `release_proof` skipped (opt-in
  proof not requested; store submission does not depend on it).