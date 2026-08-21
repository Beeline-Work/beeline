# Invite landing verification

Verified on 2026-08-12 against the real invite
`bzi_cd2f4ae16feb43b42a6566ce72ed437b38d374397b0769307c9bdcc29cfb2b38`.

- Production `GET /join/<token>` returned HTTP 200 with `Cache-Control: no-store`.
- Authenticated production relay queries returned HTTP 200 and resolved the signed record to
  `Test workspace 1`.
- `resolved-invite.png` uses those signed relay responses with the checked-in built bundle.
- `install-fallback.png` shows the no-handler result after the `beeline://` launch heuristic expires;
  the page retains the original invite URL and exposes `/dl/beeline-android.apk`.
- `apk-http-headers.txt` records HTTP 200, Android APK content type, and the 309,499,700-byte
  current signed APK from the deployment fixture.
- `resolve-error.png` shows the result of a relay HTTP 503. Clicking Retry issued a second
  `/query` request, also observed as HTTP 503, rather than leaving the page pending.
- Android accepted the then-current deep link. This historical capture predates the
  `app.usebeeline.mobile` identity and must be rerun for the new binary.

Production currently returns HTTP 404 for `/dl/beeline-android.apk`. Deployment must copy the
current signed GitHub release APK to that stable relay-front path before publishing the updated
invite page.
