# Sign-in investigation checkpoint

Brief revision: 1. Draft implementation; native acceptance work remains.

Checks at checkpoint: root npm run typecheck passed; auth suite passed (269 tests); targeted mobile sign-in/onboarding suites passed (28 tests); git diff --check passed. Device proof has not run.

Native compilation now passes: after `npx expo prebuild --platform android --no-install`, run `./gradlew :google-account-picker:compileReleaseKotlin --no-daemon --max-workers=2 -Dorg.gradle.jvmargs=-Xmx3g` from apps/mobile/android. Gradle reported BUILD SUCCESSFUL. This verifies the real Credential Manager dependency/API integration compiles; it is not a Play-signed installation or picker recording.

CI repair: the non-Android fallback references the Android implementation's type through an erased type-only import, keeping their contracts aligned and exposing Metro's platform dependency to Knip without loading Android code on iOS/web. `npm run dead-code` passes with no baseline additions.

Delivery validation: the bundled browser stand-in in sources/test/onboarding-google.browser.test.ts also passes R-signin-dismiss, rendering successful recovery after dismiss and interrupted reads (recovered=true, reads=4). This is a browser harness using the production Google session module, not an Android picker recording or the production onboarding layout. Screenshot output is disposable under .beeline-proof/signin/google-recovery.png.

## Reproductions

- R-signin-dismiss: run Google sign-in; browser resolves dismiss immediately; completion remains pending for four seconds. Before: browser_canceled after roughly two seconds. After: same recovery ticket returned. Mobile regression observed failing before the fix and passing afterward.
- R-signin-entry: exchange succeeds, GitHub repository discovery fails. Entry must still navigate to /beeline/channels. Also restore an already saved session before polling an obsolete consumed Google continuation. Both rendered onboarding regressions pass. These are stand-ins; the production trail alone cannot prove which interruption affected each phone.
- R-signin-native: native picker returns a nonce-bound signed Google ID token; server validates it and issues the existing recoverable ticket. HTTP route tests pass for recovery, replay, tenant isolation, wrong nonce/issuer/audience/authorized party and wrong recovery secret. Real picker/device proof remains outstanding.

## Production evidence

Read-only Neon requests, no messages. Measured at 2026-10-28T21:30:00Z. Noninternal Android/iOS rolling window: tapped (23), signed_in (8), workspace_created (6). Calendar window October 1–28 gives the same counts. The brief's tap denominator (24) was not reproduced; stage entry must not be conflated with signed_in.

Exact rolling count SQL:

```sql
WITH e AS (SELECT e.* FROM signin_funnel_events e JOIN signin_funnel_installs i USING(install_id) WHERE NOT i.internal AND e.platform IN ('android','ios') AND e.occurred_at >= '2026-10-28T21:30:00Z'::timestamptz - interval '28 days' AND e.occurred_at < '2026-10-28T21:30:00Z'::timestamptz) SELECT count(DISTINCT install_id) FILTER(WHERE event='provider_tapped') tapped, count(DISTINCT install_id) FILTER(WHERE event='signed_in') signed_in, count(DISTINCT install_id) FILTER(WHERE event='workspace_created') workspace_created FROM e
```

Exact signed-in-without-workspace trail SQL:

```sql
WITH e AS (SELECT e.* FROM signin_funnel_events e JOIN signin_funnel_installs i USING(install_id) WHERE NOT i.internal AND e.platform IN ('android','ios') AND e.occurred_at >= '2026-10-01'::timestamptz AND e.occurred_at < '2026-10-29'::timestamptz), stuck AS (SELECT DISTINCT install_id FROM e WHERE event='signed_in' EXCEPT SELECT DISTINCT install_id FROM e WHERE event='workspace_created') SELECT left(e.install_id::text,8) install,e.event,e.provider,e.outcome,e.occurred_at,e.screen,e.error_code FROM e JOIN stuck USING(install_id) ORDER BY install,e.occurred_at
```

Exact metadata/workspace membership check SQL:

```sql
WITH e AS (SELECT e.* FROM signin_funnel_events e JOIN signin_funnel_installs i USING(install_id) WHERE NOT i.internal AND e.platform IN ('android','ios') AND e.occurred_at >= '2026-10-01'::timestamptz AND e.occurred_at < '2026-10-29'::timestamptz), stuck AS (SELECT DISTINCT install_id FROM e WHERE event='signed_in' EXCEPT SELECT DISTINCT install_id FROM e WHERE event='workspace_created') SELECT left(e.install_id::text,8) install,e.platform,e.version,e.event,e.occurred_at, EXISTS (SELECT 1 FROM identities p JOIN memberships m ON m.identity_id=p.id WHERE encode(sha256(convert_to('beeline-onboarding:'||p.id,'UTF8')),'hex')=i.account_hash) has_workspace FROM e JOIN stuck USING(install_id) JOIN signin_funnel_installs i USING(install_id) WHERE e.event IN ('signed_in','callback_result') ORDER BY install,e.occurred_at
```

Redacted trail: Android version 0.2.22, install prefix 86daff49: GitHub error at 2026-10-22T17:20:57Z; retry tap at 17:30:51Z; success callback at 17:32:05.607Z; signed_in at 17:32:05.637Z; sign-in screen again at 17:32:53.582Z. Android version 0.2.22, install prefix 9a5d9076: Google tap at 18:22:57.573Z; success callback at 18:23:13.646Z; signed_in at 18:23:24.089Z. Neither has a workspace membership or workspace_created event. There are no screen_shown events for either trail. Do not claim this ledger establishes the precise device-side exception.

## Verified native setup dependency

Squire read-only session inspected the existing beeline-production-oauth project. Credentials table lists only play-reports-reader (Desktop) and Beeline Workspace production (Web application); no Android OAuth clients. Production web client ID is public: 856844667369-t00i2t4o4s31i0va8ipbj60qsgb97eka.apps.googleusercontent.com. No configuration was changed. Session closed.

Ruby subsequently supplied the Play Android client: 856844667369-u6shseggso8gamd9kf4ajohn4p7jsnmo.apps.googleusercontent.com, package app.usebeeline, SHA-1 F2:0F:2C:D9:D8:B0:13:1E:24:27:89:DC:20:DC:87:11:01:FF:53:C3. The server Fly configuration now sets BEELINE_AUTH_GOOGLE_ANDROID_CLIENT_IDS to that public client ID; applying it awaits the normal server release.

The EAS upload certificate SHA-1 is A1:2B:F1:07:C8:C1:CC:61:E7:46:2C:BB:CC:73:11:51:97:37:E7:9C; it has no Android OAuth client. The unused Play hybrid certificate SHA-1 is C5:6C:2C:67:8A:8B:68:C5:08:2B:7C:E1:CE:5B:2E:81:E9:AA:FB:CB; it also has no client. Ruby explicitly instructed not to create either client. Device proof must use a Play-signed internal-track installation.

EAS API inspection found the latest finished Android builds (version codes 39, 38, 37) all at commit b52aa384653a6e185683a9dd2b964291cb935805, which predates this native module. Those builds cannot demonstrate this picker. Store publishing requires owner dispatch naming a track under docs/release-pipeline.md; no store publication or release was performed here.

## Work remaining

- Complete exact root-cause attribution for each production signed-in trail if additional diagnostics establish it; current code fixes two reproducible entry hazards without pretending they prove a particular production exception.
- Exercise the compiled native Kotlin module in a Play-signed internal-track build. Runtime pins and native fingerprints are updated for the native module; the picker requires a new Android store build. The release policy requires owner dispatch naming the internal track before publishing it.
- Before/after Android recordings and Bone/Obsidian screenshots of the actual unchanged sign-in screen.
- Demonstrate entry using built app/service under the reproduction IDs, including account linking and recovery.
- Native cancellation revokes recovery and has a passing regression. Verify interrupted completion further on the device.
- Re-run affected checks after subsequent edits. Commit/push only the assigned feature branch, rebase remote branch before push, open PR with exact SQL/counts and required Reproduced/Demonstrated sections. No merge or release is authorized by this checkpoint.

