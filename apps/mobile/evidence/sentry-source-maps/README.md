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
5. Run Expo prebuild for Android and iOS without installing native dependencies.
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
