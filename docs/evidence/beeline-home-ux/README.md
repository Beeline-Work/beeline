# Beeline home UX, API 36 proof

Captured from the signed production APK on the `buzzy_api36` emulator (Android API 36,
1080 × 2400). The APK was built with `npm run apk:release` and installed over the existing
`app.buzzy.mobile` package, preserving the install identifier.

- [Home, rail closed](01-home-rail-closed.png): `BEELINE HOME`, full-width channel list, and the
  standalone invite guidance.
- [Space drawer open](02-space-drawer-open.png): tapping the Beeline mark reveals the overlaid
  community rail and scrim.
- [Invite link ready](03-invite-link-ready.png): the visible `invite people` action minted a fresh
  live `buzzrouter.com/join/...` URL with Share and Copy actions.
- [Standalone create-community path](04-standalone-create-community-path.png): the standalone
  invite affordance routes directly into the existing community creation flow.

Native APK metadata was also checked with Android build-tools `aapt`:

```text
package: name='app.buzzy.mobile' compileSdkVersion='36'
application-label:'Beeline'
```
