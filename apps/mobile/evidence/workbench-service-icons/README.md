# Workbench KEYS: service names and real service icons

The KEYS list on the Workbench, after the row title became the vault's
`service` (Resend, Sentry, ipinfo) instead of the vault's `default` LABEL, and
after the leading mark became the service's real favicon fetched exactly the
way Trusty Squire fetches it.

| file | shows |
| --- | --- |
| keys-online.png | The KEYS list with real service names and real fetched icons: `resend` (two keys — the second reads `resend · firstmate-rc34`, because a label only distinguishes when two keys share a service), `Sentry`, `ipinfo`. Each plate holds Google's favicon for the server-derived brand domain (`resend.com`, `sentry.io`, `ipinfo.io`). |
| keys-offline.png | The same list with the network blocked. Every favicon request fails, the image is dropped, and the lettermark painted behind it (`R`, `R`, `S`, `I`) reads in the house face on the house plate. No row breaks. |

## How these were captured

These are **react-native-web render proofs**, not emulator screenshots — the
same technique the original Workbench KEYS evidence used
(`apps/mobile/evidence/workbench/README.md`). The emulator rig on this host is
signed out of production and the GitHub OAuth page asks for credentials this
agent does not hold, so a live Workbench read (which needs a paired Trusty
Squire vault) could not be driven from `emulator-5556`.

The proof builds the REAL `SettingsRow` + `ServiceMark` composition the
Workbench screen draws, with the REAL row helpers
(`connectionTitle`, `connectionCompany`, `connectionDomainsLine`,
`connectionInstrument`), reads the shipped theme, and fetches the real
`https://www.google.com/s2/favicons?domain=<domain>&sz=64` URLs over the
network:

```sh
node apps/mobile/scripts/render-workbench-keys-proof.mjs   # serves :4179
google-chrome --headless=new --no-sandbox \
  --window-size=393,420 --force-device-scale-factor=2 \
  --virtual-time-budget=9000 \
  --screenshot=apps/mobile/evidence/workbench-service-icons/keys-online.png \
  http://127.0.0.1:4179
google-chrome --headless=new --no-sandbox \
  --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" \
  --window-size=393,420 --force-device-scale-factor=2 \
  --virtual-time-budget=9000 \
  --screenshot=apps/mobile/evidence/workbench-service-icons/keys-offline.png \
  http://127.0.0.1:4179
```

The connection list in `apps/mobile/scripts/workbench-keys-proof.tsx` is the
deduped shape of the real Trusty Squire vault metadata (read from
`GET https://trusty-squire-api.fly.dev/v1/vault/credentials`): resend carries
several entries, Sentry two, ipinfo one, each with the server-derived
`faviconDomain` the Workbench DTO now projects.

The two frames were checked mechanically, not by eye: the online DOM holds the
four `<img>` elements with the Google favicon URLs and the plate pixels carry
the brands' own colours (ipinfo blue, Sentry purple, resend black/white); the
offline DOM holds zero favicon `<img>` elements and zero saturated pixels,
leaving the lettermarks to carry the row.

## What the diff does

- `packages/api-contract/src/workbench.ts` — `faviconDomain(allowedHosts)`,
  the server-side brand-domain reduction (first allowed host → registrable
  domain), and the new `faviconDomain` field on `WorkbenchConnectionView`.
- `apps/server/src/phone-service.ts` — projects `faviconDomain` on the
  Workbench read and the connection detail read.
- `apps/mobile/sources/buzz/workbench.ts` — `connectionTitle` (service, never
  the `default` label; the label joins only when two keys share a service) and
  the carried `faviconDomain`.
- `apps/mobile/sources/components/buzz/ServiceMark.tsx` — the real favicon
  over the lettermark fallback, with the privacy note updated to record why
  Google's favicon service answers the third-party-leak concern.
