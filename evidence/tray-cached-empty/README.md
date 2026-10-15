# TRAY-CACHED-EMPTY-1

Android 15, `se_api35`, an isolated Beeline-leased emulator on squire.

The production signed-in app was not exercised. The narrow native stand-in
in `apps/mobile/tray-store-proof` runs the production `needs-you-store`, its
badge/list hooks, `loadTrayList`, and `NeedsYouCell` in Expo Go. Identity,
phone transport, live registration and saved storage are fixture adapters.
The fixture holds two server items and a stale empty saved Needs-you list;
Saved is also cached empty. It never contacts the production server.
Expo Go adapters stand in for Unistyles, the swipe wrapper, and unused
dialog actions because the app's native Worklets version is unavailable.
The small navigation shell is a stand-in, not a screenshot of `TrayScreen`.
Component regressions separately open the production `TrayScreen`.

## Reproduced

Cold-start the baseline store, wait for the badge read, then tap Open Tray.

- [Before opening](before-closed.png): two waiting items, one `countNeedsYou`.
- [After opening](before-open.png): zero rows and “Nothing needs you,” still
  only one request. The baseline also drops the badge to zero when the stale
  empty disk list seeds the store. Thus the exact simultaneous positive-badge /
  empty-list report was not reproduced on this checkout; the same cold-start
  path demonstrably loses the two real asks on opening.

## Demonstrated

Cold-start the changed store with identical fixture data, wait for the badge
read, then tap Open Tray. [After opening](after-open.png): two waiting items,
two complete question rows, exactly one `readNeedsYou` request. Opening adds
no request. TRAY-CACHED-EMPTY-1 passes using this native stand-in.

The existing row DTO is reused without additional fields. The fixture's
uncompressed JSON response is 335 bytes versus 11 bytes for its old count.
This is one initial read per viewer/Workspace store lifetime, shared between
concurrent badge consumers; refresh keys do not reread held rows. Existing
socket-gap recovery remains the other read trigger. These are fixture byte
measurements, not production traffic measurements. The full projection also
starts the server's existing first-paint question expiry clock when the badge
loads the rows, rather than waiting for a later Tray list read.

## Repeat

From `apps/mobile/tray-store-proof`, run
`EXPO_OFFLINE=1 ../node_modules/.bin/expo start --port 8096 --host localhost`.
Reverse port 8096 on the isolated emulator and open `exp://127.0.0.1:8096`
in Expo Go. Cold-start Expo Go between variants.

For the baseline variant, place the pre-change `needs-you-store.ts` at
`apps/mobile/tray-store-proof/before-store.ts` (ignored), and set
`TRAY_BEFORE=1` when starting Metro. Restart Metro when changing variants.

Regression coverage in `tray.test.tsx` opens the real Tray with 0, 1, 2, 9,
and 12 items, verifies row/badge equality despite stale disk, and checks that
the only request is the full projection. Additional cases exercise shared
in-flight badge reads, live deltas during bootstrap, held removals and
account switches. The new cold-start cases fail against the baseline store;
the positive cases render zero rows there. The changed store passes.

Validation: 85 component/store tests passed; eight browser proof tests were
excluded to keep visual verification Android-only. Root `npm run typecheck`
passed, including mobile and scripts.
