# Expo web app hosting

The production Expo web client is `https://web.usebeeline.app`. EAS Hosting
serves it from the mobile app's existing Expo project. The unified release's
`website` component exports `apps/mobile` for web, stamps the release version
and source SHA, runs `eas deploy --prod`, and then requires the custom domain to
serve that exact stamp and an Expo root document.

This is separate from every existing production origin:

- `https://usebeeline.app` remains the GitHub Pages landing site, helper
  download channel, and app-association host.
- `https://server.usebeeline.app` remains the monolith API and auth origin.
- `https://preview.usebeeline.app` remains the isolated media-preview origin.
- Existing native app links and OAuth callbacks do not move to the web host.

## One-time EAS and DNS setup

1. In the existing Expo project's Hosting settings, promote a deployment to
   production and assign `web.usebeeline.app` as its one custom domain.
2. Add the exact verification TXT and certificate-validation CNAME values shown
   by Expo. Wait for each check to pass before changing traffic.
3. Add only the `web.usebeeline.app` CNAME to `origin.expo.app`. Do not edit the
   apex, `server`, `preview`, or any other record in the zone.
4. Confirm all three custom-domain checks pass in Expo Hosting settings.
5. Keep the repository's existing `EXPO_TOKEN` secret available to the unified
   release workflow. No new application secret is required.

EAS custom domains always follow the production deployment. A release is not
complete until `scripts/verify-web-deployment.mjs` reads the expected
`/beeline-web-release.json` from the canonical domain. The verifier refuses a
redirect or a substituted origin, which prevents the old Expo preview URL or
the apex landing site from satisfying the check.

For a manual read-only check after release:

```sh
curl --fail --silent --show-error https://web.usebeeline.app/beeline-web-release.json
curl --fail --silent --show-error https://web.usebeeline.app/
curl --fail --silent --show-error -X OPTIONS \
  -H 'Origin: https://web.usebeeline.app' \
  -H 'Access-Control-Request-Method: POST' \
  https://server.usebeeline.app/v1/auth/review/exchange -D - -o /dev/null
```

The preflight must return `204` with
`Access-Control-Allow-Origin: https://web.usebeeline.app`. An arbitrary origin
and the retired temporary Expo preview origin must receive no CORS grant.

Rollback is an EAS production-alias operation: promote the last known-good
immutable deployment in Expo Hosting. Do not repoint DNS to another Beeline
origin. After promotion, verify that deployment's recorded marker and rerun the
three checks above.
