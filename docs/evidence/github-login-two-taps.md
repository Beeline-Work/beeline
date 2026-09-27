# GitHub sign-in Android validation

- Test APK: current branch JavaScript embedded in the existing signed Android release APK, configured for `https://server.usebeeline.app`; installed on emulator-5570. The original APK was restored on emulator-5554.
- Offline, fresh app data: airplane mode on, launch, tap Continue with GitHub once. The app showed one NO CONNECTION notice and Try again; Chrome did not open. The same notice held after 25 seconds offline and 10 seconds after restoring the network, without another request from the UI.
- Online: tap Try again. Chrome opened the production Beeline App GitHub authorization sign-in page. This emulator has no authenticated GitHub browser session, so the return callback and fully signed-in landing were not driven live.
- Component reproduction: a cold `completed=1` callback whose completion endpoint answered 202 twice then 200 left onboarding at sign-in before the fix. After the fix, the same callback exchanges the proof once and shows the face ceremony. The first success path with an immediate completion response already had coverage; the delayed result distinguishes the failure.
- Focused `cso` auth-diff pass and manual review: no P0/P1 finding. Callback state is checked on each retry; a replaced session is rejected, and challenge parsing plus the one-use exchange remain unchanged. Offline retry is bounded and does not restart the browser.
- Focused mobile tests: 81 passed. JS Android bundle export and signed APK verification passed.
- Typecheck fails on four existing `fastMode` signature errors in chat and members files outside this diff. Native fingerprint check fails for both platform runtime pins with no native or config file changed in this branch; the installed dependency tree influences the computed hashes.
