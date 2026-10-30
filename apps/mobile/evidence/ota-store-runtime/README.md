# OTA-STORE-40

The original planner selected Android 43/42/41 for v0.1.121. The regression
expects exactly 40/39/38 with the observed production store record; 41/42/43
are not downloadable. When 43 actually goes live, the regression expects
43/40/39. iOS has an independent record and the same selection rule.

## Store evidence

Play Console was read with the owner's authenticated account, without publishing.
Production shows build 138 available on Google Play, released Oct 26. The signed
universal APK downloaded from its bundle explorer identifies versionCode 138 and
`string/expo_runtime_version = "40"` in aapt2. Original APK SHA-256:
`ba978706fc4efe3753a9afee424064657f147cc292190990d3701cc364307363`.

The captured `play-production-history.txt` records builds 129 and 127 as released
on Oct 18 and Oct 17. Build 128 has a dash for its release date and is excluded.
`scripts/seed-store-runtime-history.mjs` parses this one-time export and resolves
those build identities against native evidence. Upload receipts:

- Run 40028613502: build 138, source 62a269572454, Android pin 40.
- Run 39154561183: build 129, source 6e51856d5c76, Android pin 39.
- Run 39047023529: build 127, source c12d9c5e96f4, Android pin 38.

Subsequent releases write publication observations and build identities into the
cumulative OTA delivery index. New upload identity artifacts are automatic and
never prove publication by themselves. App Store history is read from ASC
version/build relationships; replaced versions prove past distribution, while
review and TestFlight versions do not.

## Read-only plan

`production-history.json` is a real authenticated EAS GraphQL production branch
read (2026-10-30). `store-status.json` records the live Play/bundle observation
and the seed generated from the captured Play history. Run from `apps/mobile`:

```sh
node scripts/ota-release.mjs publish --dry-run \
  --production-history evidence/ota-store-runtime/production-history.json \
  --store-status evidence/ota-store-runtime/store-status.json \
  --sha e803361eb --ref main --ledger /tmp/ota-plan.json
```

Observed target list:
`android@40,android@39,android@38,ios@34,ios@35,ios@36`.

Local ASC signing environment is absent. The vaulted ASC credentials contain
signing-key components rather than a pre-signed bearer token; the sealed HTTP
route cannot sign a JWT locally. App Store Connect browser requires an Apple
login and no saved Apple username/password exists. The plan therefore exercises
the required iOS fallback: preserve the previous release's entire iOS set.
ASC publication filtering, history and unknown-build failure behavior are covered
by the adapter tests. Live release runners already have ASC signing secrets;
the OTA jobs now receive them for the read-only query.

## Native compatibility demonstration

The 41–43 changes already guard their JS entry points:
`google-account-picker.android.ts` uses `requireOptionalNativeModule` and the
Google session falls back to the browser; `android-modal-navigation-bar.ts` and
`android-launch-appearance-native.ts` tolerate absent modules and methods.
No new guard or native pin change was needed.

Built today's Android JS export using `expo export --platform android
--max-workers 2`. Replaced only `assets/index.android.bundle` in the downloaded
build 138 APK using `repack-current-js.py`, zipaligned it and signed it with
`SignProof.java` using a newly generated in-memory test key. No owner signing
credential is read. Every DEX and native library is byte-identical to the store
APK (154 files); the substituted bundle matches the exported HBC exactly.
`device-proof.json` records hashes and source identity. This is a local native
compatibility stand-in; it does not exercise Expo's production delivery service.

Installed on corner emulator 5566. Network was disabled for cold start to keep
Expo from replacing the embedded proof bundle with an existing production OTA.
Current JS renders the sign-in screen (`android40-current-js.png`). After
re-enabling network, tapping Google opens Chrome's browser ceremony
(`android40-google-browser.png`), without a missing GoogleAccountPicker crash.
No account was created or signed in. No native modules were added to the APK.

## Timing and limits

The actual v0.1.121 OTA job ran from 02:11:52Z to 02:16:29Z: 4m37s.
After-change live publishing time is unmeasured: publishing is explicitly outside
this brief. The observed read-only plan completes in under one second locally;
that is planning time, not a delivery benchmark. Target count remains six for
this real snapshot, with one JS export per platform reused for all targets.
Store evidence collection has a two-minute ceiling inside the unchanged
18-minute OTA job cap; lookup failure preserves targets. No timeout was raised.
