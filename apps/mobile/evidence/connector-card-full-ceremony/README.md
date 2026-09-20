# Connector offer — full in-chat ceremony

Captured on `emulator-5554` (API 36) from this branch's Expo development client,
pointed at an isolated local monolith (`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:8795`)
and signed in as the seeded Play review identity (`beeline://review/<secret>`),
landing in `#welcome`.

The human ask never names the connector product:

> Hey @echo, can you sign me up for Groq and get me an API key?

Tapping the offer card opens the existing Settings → Workbench → Connect
install + sign-in overlay. The helper's `connected` report settles the card
and only then resumes the paused turn. No raw key appears in chat.

| Capture | Shows |
| --- | --- |
| `01-after-dev-client.png` | Development client on the isolated monolith, signed out. |
| `02-review-signin.png` | Review deep link lands on the Beeline Welcome deck (`#welcome`, `#proof`). |
| `03-welcome.png` | Empty `#welcome` composer. |
| `04-ask-typed.png` | Ordinary Groq ask typed, no connector product name. |
| `05-ask-sent.png` | Ask posted in `#welcome`. |
| `07-offer-card-full.png` | `Add Trusty Squire as a tool?` card with the one affirmative action. |
| `10-ceremony-open.png` | Tap routes into `Connect Trusty Squire` (the existing Workbench ceremony). |
| `11-signin-button.png` | Helper reports install progress and `Sign in to Squire`. |
| `12-signin-webview.png` | Sandbox WebView overlay over the connect screen. |
| `13-signin-webview-loaded.png` | Overlay loaded the helper's reported sign-in URL. |
| `14-after-connected.png` | Helper `connected` settles the card: `ADDED BY @PLAY-REVIEW` · Manage in Workbench. No raw key. |
| `15-workbench.png` | Workbench: Trusty Squire `connected`, KEYS lists `Groq API` (`groq · api.groq.com`, `active`). |

Notes:

- Echo has no live helper on this isolated stack, so the ask also produced the
  ordinary offline / stalled-turn lines. The offer card and ceremony are
  independent of that helper loop: accept still pairs the Workbench row and
  waits for `installConnector` before resume.
- Production Trusty Squire account sign-in and live Groq key issuance are not
  available on this local helper. The vault row is metadata only (no secret
  bytes in chat or on the phone).
