# Beeline session persistence, 2026-10-12

The reported sign-in screen was not evidence that the captain's recent server sessions had been revoked. Both recent families (`f55d7968`, created October 9; `77a4db58`, created October 12 at 19:53 UTC) still had one unconsumed, unexpired row in the read-only production query. A successful rotation would consume the row; replay rejection would delete the family. Neither happened to these families. The absence of access tokens is expected after 15 minutes without successful renewal: the 19:53 access token expired around 20:08, before the reported 20:40 sign-in screen.

Two client paths reproduce the false sign-out:

- `loadBuzzIdentity()` awaited token renewal and converted every exception into `null`. Home and the Room deck interpret `null` as a signed-out device and navigate to onboarding. An offline launch, deploy interruption, timeout or bad refresh body could therefore hide a valid saved session. Identity restoration now reads the device; authenticated operations renew their own access.
- Android retains the launching auth Intent across an OTA JavaScript reload. After successful GitHub sign-in clears its pending state, replaying that old callback threw `state_mismatch` before onboarding could notice the saved identity. Completed launch callbacks now return to Rooms when the device is signed in; a genuinely pending flow still receives its state and expiry checks. The native OTA experiment also reproduced repeated redemption of a retained review link. An already accepted review link now reuses its session, using a hash stored in the existing secured access record; it needs no new desktop keychain key.

The captain's latest production Android receipt observed during investigation reported `v0.1.40`, runtime `33`, at 21:00 UTC. Database history alone cannot retrospectively distinguish a failed startup renewal from a replayed launch callback on the physical phone; no claim is made that a particular network exception was captured there. Both routing failures are reproduced and covered. The bot-DM migration deletes fixed connector identities and their rooms; regression coverage verifies that human access and refresh sessions survive it.

The previous lost-reply change, [Keep Beeline signed in after a lost refresh reply](https://github.com/Beeline-Work/beeline/pull/2351), also left two deliberate forced sign-outs: a retry beyond 120 seconds revoked the family, and inactivity expired the refresh credential after 30 days. The requested lifetime is now explicit device revocation or account deletion. Access tokens still expire after 15 minutes. New renewals retain the same high-entropy device credential; old sealed rotation chains recover into their current credential without punishing the whole family. An unrecoverable pre-replay token is refused without deleting its live successor's family.

`/v1/auth/logout` revokes the presented family and its access tokens idempotently. Other devices remain signed in. Offline sign-out still erases local credentials when remote revocation cannot reach the server. Device credentials remain hashed server-side and protected by the platform's existing storage; a stolen credential requires revocation rather than waiting for age-based expiry. The maintenance sweep retains device sessions. The one-time migration gives existing rows a date-valued lifetime sentinel, preserving the row shape older server images expect during rollout or rollback.

Client regressions additionally cover a body that stalls after HTTP headers, late refresh replies after account switch or sign-out, and an old browser-tab response arriving before the newer sign-in's storage event. A rejected write from an old account is never retried as the newly signed-in person. Credential writes and deletion share a local queue; shared browser storage is checked before a refresh can erase or overwrite it.

## Validation

- Root `npm run typecheck` passed, including mobile and scripts.
- `npm run dead-code` held its baseline: 91 existing findings, zero introduced.
- Server auth, full HTTP integration, maintenance and bot-DM suites: 301 tests passed.
- Mobile auth, onboarding callbacks, review route, root routing, updates and identity settings: 197 tests passed.
- Shared packages: API contract 465, Nostr 8, client 399 tests passed.
- After fast-forwarding the two new `main` commits, root build/typecheck/dead-code and shared package checks passed again; the combined auth, bot-migration and public-invite matrix passed 22 tests, and the HTTP auth integration passed again.

## Android release experiment

The artifact is a real `assembleRelease` build: Android package `app.usebeeline`, version `0.2.21`, runtime `33`, Hermes, no `DEBUGGABLE` flag and no Metro server. It uses local test signing and an isolated real server/auth implementation over PGlite. It is a release candidate, not a newly promoted production release. Production database inspection used `BEGIN READ ONLY`; no production deployment, merge or SQL mutation was performed.

20-minute artifact SHA256: `ff5a406599bf968c6fbfd38aa34c4acb75d7e6c7162fde8694f5a60151ed9cd6`.

Only the worker's `-read-only -port 5586` emulator was driven. The shared `emulator-5554` was not used. Sign-in used the ordinary `/review/<secret>` app route against the isolated server; the first-account welcome carousel was completed through its real controls. The server is recreated over the same database for deploy checks. The proxy deliberately lets one renewal commit, then withholds its reply. The test waits through the actual 15-minute access lifetime and sleeps beyond the former replay grace; it does not accelerate the Android clock.

The local OTA is delivered through the native Expo Updates protocol with a new update id, matching runtime, the release's Hermes bundle and app configuration. Its timestamp uses the millisecond UTC form parsed by the installed SDK. The first fixture used an unsupported timestamp format and was corrected before the recorded long run; that aborted fixture is not counted as a passing run.

The final candidate also passed an in-place update and continued using the same sign-in after the additional stale-write guard; its APK SHA256 is `55ed83c6a4c104db549b20f246013734b88e0b995ab947e4b04e6be3b6ed9d9e`.

The first lost reply was recovered by an automatic retry before the later sleep. The offline restart therefore held renewed access; the historical checkpoint name `expired-access-offline-cold-start` is not an assertion that this renewed access had expired. Delayed retries beyond the old grace are covered by the four-day legacy server regression and the 24-hour cold-client regression.

The recorded timeline and screenshots are in [session-persistence evidence](../apps/mobile/evidence/session-persistence/). Every passing checkpoint requires one initial sign-in and one retained device family; online checkpoints also verify the Room deck. A separate in-place APK installation verifies that package updates retain the same sign-in.

To reproduce in a fresh isolated worktree:

1. Build workspace packages and a release APK targeting `http://10.0.2.2:45861`, with a private test updates channel. In the generated, uncommitted Android manifest, allow the local HTTP fixture and set the Expo update URL to `http://10.0.2.2:45861/updates`. Do not change production app configuration or runtime pins.
2. From the repository root, create the ignored `.task-proof/` output directory and run `node --import tsx apps/mobile/evidence/session-persistence/harness.mts`. It binds only the local host and uses no production credentials.
3. Launch your own read-only emulator on a free port, install that APK there, and redeem `beeline://review/isolated-session-proof-secret-1234`. Never select the shared rig. Grant notifications on that emulator to avoid covering the app with a permission prompt.
4. Put the APK's `assets/index.android.bundle` at `.task-proof/ota.bundle`. Create `.task-proof/ota-manifest.json` with a fresh UUID, `createdAt` in `YYYY-MM-DDTHH:mm:ss.SSSZ`, runtime `33`, a launch asset URL `http://10.0.2.2:45861/ota.bundle` and its SHA256 base64url hash. Include the public Expo client configuration in `extra.expoClient`, preserving the local server setting.
5. Run `python3 apps/mobile/evidence/session-persistence/run.py --device emulator-<your port>`. The runner does not launch or stop an emulator and refuses `emulator-5554`. It writes the measured timeline and screenshots to `.task-proof/`.

Promotion and a production canary remain the release authority's next step after this direct PR is reviewed and merged. These results do not claim that the captain's physical phone is already running the fix.
