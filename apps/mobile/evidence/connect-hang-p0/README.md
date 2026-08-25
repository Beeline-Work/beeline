# Cold-cache relay bootstrap P0

Captured on `emulator-5554` with the captain's logged-in
`app.usebeeline.mobile` install and the production relay. The MMKV store held
only `buzz-local-cache-v2`, so every run below exercised an empty v3 cache.

- `before-app-usebeeline-hung.png` — the #460 OTA remained on
  `CONNECTING TO RELAY` for more than 90 seconds.
- `after-cold-v3-loaded.png` — the fixed bundle populated and rendered the
  production Room list on the same cold-cache path.
- `after-stalled-relay-retry.png` — outbound traffic for only the app UID was
  rejected; eight seconds after the bootstrap began, the spinner became a
  visible empty-list error with `RETRY`.
- `after-retry-loaded.png` — after restoring traffic and pressing that same
  `RETRY` button, the production Room list loaded without restarting the app.

The test bundle was copied into the already-downloaded OTA asset solely for
device verification because the local release key cannot update the Play-
signed install. The original #460 asset was restored byte-for-byte afterward.
