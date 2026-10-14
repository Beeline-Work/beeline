# CI runtime pin regression

Reproduction voice-screen-off-ci-1: run the mobile app branding and native fingerprint tests on PR head 4aa08ff533b3. Three assertions fail because they expect Android 36/iOS 34 while app.config.js and native-fingerprint.json pin Android 37/iOS 35.

Read GitHub job logs 115709593564 (MOBILE SUITE), 115712700705 (FRAME-BUDGET), and 115712700804 (STATE-UPGRADE). MOBILE SUITE reports two failing test files and three failed tests. Both dependent gates explicitly derive their verdict from MOBILE SUITE; they report its failure rather than an independent frame/storage regression.

Local reproduction: `cd apps/mobile && npx vitest run sources/config/appBranding.test.ts sources/config/nativeFingerprint.test.ts` exits 1 with the same three assertions. Update the explicit runtime expectations to 37/35 and the next required Android native bump to 38. Preserve the real native-input mutation and refusal-to-write checks.

## Demonstrated

Reproduction voice-screen-off-ci-1 now passes in the full mobile suite: 535 test files passed, four skipped; 4,499 tests passed, five skipped. This includes all 12 native fingerprint tests, four frame-budget tests and three state-upgrade tests. The real native edit still fails the fingerprint gate until a new runtime is pinned; the next Android pin is 38. Root typecheck and 37 focused server voice tests also pass.

This CI repair changes only test expectations. It does not establish the outstanding locked-screen idle/reply/restart or hour-soak acceptance.
