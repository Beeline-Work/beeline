# Mobile Sentry source maps

Reproduction mobile-sentry-maps: open Android event
[d28b5cf4177f4e15b6e5874caa89c920](https://beeline-bt.sentry.io/issues/7803536337/events/d28b5cf4177f4e15b6e5874caa89c920/).
The API returned `js_no_source` / `missing_source`; frames name
`app:///index.android.bundle`, line 1. The full release is
`6e51856d5c76b1ba1c0df948c0aaf10e2f0ba6fb`.

## Local demonstration

On 2026-10-21 UTC, after `npm run corner:prepare`:

1. Export the actual Android app using `npx expo export --platform android
   --source-maps --max-workers 2 --output-dir /tmp/jellybean-sentry-export`.
2. Metro bundled 3,694 modules and produced the 13 MB Hermes bundle and 29 MB
   composed map. The map includes `x_hermes_function_offsets` and debug ID
   `a24f9c6d-35cb-4b26-8ff9-621fe17a157b`.
3. Resolve generated line 1, column 771135 with `source-map`'s
   `SourceMapConsumer.originalPositionFor`: `/sources/buzz/sentry.ts:47:1`.
4. Run the uploader against that actual export with an intercepted CLI call:
   it selects the matching `.hbc` and `.hbc.map`, the full source SHA, and
   `--debug-id-reference`. No network upload is claimed by this local check.
5. Historical proof from the initial revision (native support has since been removed):
   run Expo prebuild for Android and iOS without installing native dependencies.
   Android app Gradle applies `sentry.gradle.kts`; Xcode's bundle phase wraps
   `react-native-xcode.sh` in `sentry-xcode.sh`. Neither generated app entry
   adds native Sentry initialization. Generated projects were removed afterward.

## Remaining real-target proof

AC-3 is pending. The personal GitHub token returns HTTP 403 for Actions secrets,
and the browser account cannot open repository secret settings. Provisioning
`SENTRY_AUTH_TOKEN` from the existing vault release token requires repairing
that access. No token was fetched or written. No release was dispatched.

After secure provisioning, upload the actual composed map and bundle, send one
labelled staged Android exception with that bundle's debug ID and full release
SHA, and verify a symbolicated in-app frame through Sentry's event API. Record
the event link here. Local mapping alone does not establish Sentry ingestion.

## Owner rework

Native configuration, fingerprint policy and recorded runtime pins are restored
to main. Native embedded uploads are deferred. Only the OTA export queues the
upload, in a detached worker: release publication never waits for Sentry.
The worker warns on upload failure; CLI output is suppressed to avoid logging
credentials. A runner shutdown can interrupt the best-effort upload.
The CI wiring references `SENTRY_AUTH_TOKEN` only; no secret was provisioned.

Rework stand-in passed on 2026-10-21: Android export bundled 3,696 modules;
the composed Hermes map has debug ID `d5928fb9-3abe-4212-b7d6-13fbd92bb665`.
Generated line 1, column 771159 resolves to `/sources/buzz/sentry.ts:2:0`.
The intercepted uploader selected that export's matching `.hbc` and `.hbc.map`.
No network upload or live Sentry symbolication is claimed. Offline publish
planning retained Android 39/38/32 and iOS 36/35/31 with source maps enabled.
Fingerprint check passed at Android 39 / iOS 36; the three native input files
have an empty diff against main. Changed-path planning excludes mobile-native.
