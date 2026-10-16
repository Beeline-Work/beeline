# Beeline error monitoring

Sentry owns errors; the Beeline server relays new issues and regressions to the
Squire Monitor Telegram chat. Firstmate selected that destination on 2026-10-16.
The bot is outbound-only here: never call `setWebhook`, `deleteWebhook`, or
`getUpdates`, because Squire owns its inbound update delivery.

## Account and configuration

The free Developer organization is **beeline-bt**, owned by
**lunchboxfortwo@gmail.com**. Do not use the unrelated methoxine organization.
Projects are `beeline-server`, `beeline-helper`, and `beeline-mobile`.

[Sentry alert](https://beeline-bt.sentry.io/monitors/alerts/6181673/):
**Notify via Beeline Telegram**, all projects, new issue OR resolved issue
regresses, no action throttle. The internal integration is
[Beeline Telegram](https://beeline-bt.sentry.io/settings/developer-settings/beeline-telegram-483a53/).
Its destination is `POST https://server.usebeeline.app/api/webhooks/sentry?token=…`.
Keep that URL's token private.

| Configuration | Location | Purpose |
| --- | --- | --- |
| `SENTRY_DSN` | `beeline-server` Fly secret | Server ingestion |
| `BEELINE_SENTRY_WEBHOOK_TOKEN` | `beeline-server` Fly secret | Exact query-token authentication |
| `BEELINE_TELEGRAM_BOT_TOKEN` | `beeline-server` Fly secret | Outbound Telegram credential |
| `BEELINE_TELEGRAM_CHAT_ID` | `beeline-server` Fly secret | Squire Monitor destination |
| `BEELINE_HELPER_SENTRY_DSN` | GitHub repository variable | Public ingestion DSN embedded in release helper bundles |
| `BEELINE_MOBILE_SENTRY_DSN` | GitHub repository variable | Public ingestion DSN, exposed to Expo as `EXPO_PUBLIC_SENTRY_DSN` |
| `BEELINE_SENTRY_DSN` | Optional helper process environment | Override embedded helper DSN; empty disables capture |

All three DSNs and the `Beeline release token (beeline-bt org:ci)` and
`Beeline alert setup token (lunchboxfortwo, beeline-bt)` are in the Squire vault
under Beeline labels. Use the scoped setup token through `use_credential` for
Sentry API requests; do not export tokens into chat, files, or builds. No auth
token is needed for event ingestion. Source-map upload is not configured by
this change; current errors retain source stack frames where available.

The unified release workflow supplies the public helper and mobile DSNs from
repository variables. A local source helper uses only its explicit environment;
local development mobile builds do not initialize Sentry. Fly secrets were
**staged**, not applied to running machines: firstmate's next server release
activates them. Merging alone does not deploy this receiver.

## Capture and recovery

- Server: startup failures, unexpected HTTP failures, failed background jobs,
  and uncaught exceptions. Request status mapping and background retries stay
  unchanged. Relay delivery failures return 503 without reporting another
  Sentry issue, preventing a notification feedback loop.
- Helper: CLI fatal errors, hosted-agent failures, and the existing
  keep-running unhandled-rejection guard. Fatal exceptions drain through the
  SDK before exit(1), deferring to any existing uncaught-exception handler.
- Mobile: the Sentry React Native SDK runs in **JS-only** mode, including global
  JS error handling. Existing error boundaries and voice recovery also capture
  handled failures. The existing Android native-crash receipt is submitted to
  Sentry on the next launch/resume and still acknowledges only after the
  existing authenticated server diagnostic accepts it. A native crash cannot
  be delivered while the app is stopped. Native autolinking is excluded in both
  Expo and React Native config: current store binaries remain OTA-compatible.
  Do not enable native Sentry or remove those exclusions without a deliberate
  native runtime/store release.

Capture samples all errors. Tracing, profiling, logs, replay, screenshots,
view hierarchies, breadcrumbs and session tracking are not enabled. The shared
`packages/api-contract/src/error-reporting.ts` filter allowlists event fields,
redacts common credential/URL/email/home-path patterns, strips request/user/
context/extra data, and removes stack locals and source lines. Error messages
still need care at their source: never throw conversation text or credentials.

The relay accepts legacy `event` and modern `data.event`/`data.issue` payloads.
It posts `🔴 Beeline <level>: <title> <Sentry link>` as plain text, limits title
size, restricts links to this organization, and bounds Telegram requests to five
seconds. A Telegram rejection or timeout returns 503 for upstream retry.
`[sentry-relay] Telegram message sent <message_id>` records delivery without
logging the bot token, chat ID, webhook token, or issue text.

## Verification and release handoff

Targeted automated checks cover actual server/helper SDK envelopes against a
local HTTP collector, fatal exit(1), privacy filtering, relay authentication,
legacy/modern formatting, Telegram acknowledgement/failure, unchanged helper
rejection recovery, and mobile diagnostic/boundary recovery. The native
fingerprint check confirms unchanged Android/iOS runtimes.

**Production end-to-end verification is pending firstmate's release.** No
production test issues have been created or resolved yet. After the server,
helper bundle and mobile OTA are delivered:

1. Verify an unauthenticated POST to the production relay returns 401. Do not
   put its private query URL in shell history, logs, evidence, or this document.
2. On a production server machine, run a one-off Node process that imports
   `./apps/server/dist/sentry.js`, throws/catches an Error titled
   `Beeline Sentry E2E test server <UTC timestamp>`, calls `captureServerError`,
   then awaits `flushServerErrors`. The machine environment supplies the DSN.
   Do not crash or restart the serving process.
3. On a production helper with the delivered bundle, inject a labelled test
   rejection through a debugger into the existing `unhandledRejection` guard.
   Verify the helper keeps serving; do not start/stop/pair/update the shared
   helper merely to generate a test. The title is
   `Beeline Sentry E2E test helper <UTC timestamp>`.
4. In the delivered production mobile runtime, use debugger-only injection to
   throw/catch and report `Beeline Sentry E2E test mobile <UTC timestamp>` through
   `captureMobileError`. Never add a crash trigger to shipped mobile code.
5. For each, record the Sentry issue URL, Telegram message ID, and elapsed time.
   Require the Beeline-labelled Telegram message within 60 seconds. If any
   surface or deadline is unproven, report that explicitly.
6. Resolve exactly those three test issues in Sentry and record their final
   resolved status. The alert excludes issue-resolution notifications.

Credit/balance and server/database capacity alerts are a separate follow-up.
