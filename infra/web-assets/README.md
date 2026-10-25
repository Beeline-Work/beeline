# Web JavaScript asset guard

`worker.mjs` protects only `web.usebeeline.app/_expo/static/js/*`.
EAS Hosting's `web.output: single` falls back to `index.html` for missing
hashed scripts. The guard turns successful HTML (or an HTML 404) at a JavaScript
path into a plain, uncached 404. Existing JavaScript and origin failures pass
through. App navigation stays on EAS Hosting.

Successful, public scripts with a 32-character content hash are retained in the
Cloudflare edge cache for up to a year. This is best effort: only previously
requested chunks at that location are retained, and cache eviction remains
possible. Missing chunks use the app's existing reload recovery. That recovery
checks for a newer export, flushes drafts, and reloads at most once per target
export. EAS aliases alone do not retain older chunks at the production URL.

## Activation after review

This infrastructure is separate from the production release pipeline. Merging
the PR does not install the Worker or change DNS. No mobile release is needed.

1. Deploy the reviewed `worker.mjs` with `wrangler deploy --config
   infra/web-assets/wrangler.jsonc` using the owner's managed Cloudflare access.
   The configuration registers only the JavaScript asset route.
2. Enable proxying on the existing `web.usebeeline.app` CNAME record, preserving
   its `origin.expo.app` target. At investigation time it is DNS-only, and there
   are no Worker routes in the zone. A Worker route requires proxied DNS.
3. Verify the missing asset below returns 404 with `text/plain` for GET and HEAD.
   Fetch `/`, a deep Room URL, and a current script referenced by `/`; verify
   navigation still serves the app and current JavaScript remains JavaScript.
   Run the stale-tab browser proof below. Confirm HTTPS and EAS origin routing
   after proxying; the local proof does not establish those production facts.
4. If routing or HTTPS fails, restore DNS-only on that CNAME and remove the
   `beeline-web-assets` Worker route. This restores the previous EAS route.

Do not mark the production incident resolved until the live asset request
returns a plain 404 after activation. These changes require no edit to
`unified-release.yml`, the web release action, or native app configuration.

## Reproduction BEELINE-MOBILE-9

On October 25, the real target
`https://web.usebeeline.app/_expo/static/js/web/native-crash-reporting-00000000000000000000000000000000.js`
returned HTTP 200, `Content-Type: text/html`, with the Beeline document. Passing
that exact origin request through the local Worker entrypoint returned HTTP 404,
`text/plain; charset=utf-8` for GET and HEAD.

Run `node --test scripts/web-asset-guard.test.mjs` for response and retention
regressions. Run `npm run web:chunk-recovery:proof --prefix apps/mobile` for the
Chromium path using Expo's actual production script loader and the application's
recovery and draft code. The local origin reproduces the real host's HTML
fallback; the actual Worker sits between that origin and the browser. The
missing chunk becomes a plain 404, a stale tab reloads once, the new feature
loads, the draft survives, and a second missing chunk does not reload again.
The stand-in avoids deploying unreviewed hosting infrastructure or using a
person's authenticated production tab. It does not prove Worker route activation.

BEELINE-MOBILE-E's latest event was also inspected: its unhandled rejection is
`NetworkError: A network error occurred.`, without a stack or chunk URL. There
is no evidence tying it to this defect; generic network errors remain unfiltered.

Hosting references: [Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/),
[EAS custom domains](https://docs.expo.dev/eas/hosting/custom-domain/),
[EAS alias caching](https://docs.expo.dev/eas/hosting/reference/caching/).
