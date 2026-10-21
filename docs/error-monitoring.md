# Beeline error monitoring

Sentry owns errors; the Beeline server forwards new issues and regressions to the
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
token is needed for event ingestion. Mobile source maps are uploaded by the OTA publisher and native build hooks.
The Actions secret `SENTRY_AUTH_TOKEN` must contain the existing vaulted release
token; never put it in Expo public variables or app configuration.

The unified release workflow supplies the public helper and mobile DSNs from
repository variables. A local source helper uses only its explicit environment;
local development mobile builds do not initialize Sentry. Fly secrets were
**staged**, not applied to running machines: firstmate's next server release
activates them. Merging alone does not deploy this receiver.

## Capture and recovery

- Server: startup failures, unexpected HTTP failures, failed background jobs,
  and uncaught exceptions. Request status mapping and background retries stay
  unchanged. Forwarder delivery failures return 503 without reporting another
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

The forwarder accepts legacy `event` and modern `data.event`/`data.issue` payloads.
It posts `🔴 Beeline <level>: <title> <Sentry link>` as plain text, limits title
size, restricts links to this organization, and bounds Telegram requests to five
seconds. A Telegram rejection or timeout returns 503 for upstream retry.
`[sentry-relay] Telegram message sent <message_id>` records delivery without
logging the bot token, chat ID, webhook token, or issue text.

## Verification and release handoff

Targeted automated checks cover actual server/helper SDK envelopes against a
local HTTP collector, fatal exit(1), privacy filtering, forwarder authentication,
legacy/modern formatting, Telegram acknowledgement/failure, unchanged helper
rejection recovery, and mobile diagnostic/boundary recovery. The native
fingerprint check confirms unchanged Android/iOS runtimes.

**Production end-to-end verification is pending firstmate's release.** No
production test issues have been created or resolved yet. After the server,
helper bundle and mobile OTA are delivered:

1. Verify an unauthenticated POST to the production forwarder returns 401. Do not
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

## Private issues-triage wakes

`POST /v1/sentry/webhook` authenticates the original body using
`Sentry-Hook-Signature` (HMAC-SHA256) and the server-only
`BEELINE_SENTRY_CLIENT_SECRET` Fly secret. Missing configuration or an invalid
signature returns 401. It accepts created issues, all unresolved issues regardless
of substatus, regressed issues, and triggered `event_alert` notifications. Other
signed events are acknowledged without waking an agent. The Telegram receiver
above remains independent.

`sentry_wake_issues` stores issue metadata keyed by issue id and event type;
retries do not re-arm an acknowledged row, and a newer occurrence updates its
metadata. `sentry_wake_state` serializes ingestion and dispatch across server
machines. Fatal issues and explicitly unhandled exceptions queue a private command
for Jellybean in issues-triage immediately; later urgent issues accumulate until
five minutes after the previous urgent command. Unhandled signals include
`issue.isUnhandled`, `event.unhandled`, `handled=no` event tags, and exception
mechanisms with `handled=false`. Other issues remain pending for a separate
24-hour daily triage batch; they neither wake on arrival nor enter urgent digests.
The daily clock starts at migration and advances only when a daily batch commits.
The command and acknowledgement commit together. The existing background leader
reads both durable deadlines after restart and PostgreSQL notifications re-arm it
after arrivals. An unavailable target keeps rows pending.
The server setting `BEELINE_SENTRY_TRIAGE_AGENT_ID` selects the recipient and
defaults to Jellybean (`7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877`).
The receiver and background worker share that setting. Set it consistently on
all server machines and restart through the normal release process to change
the recipient without code. Digests instruct Jellybean to investigate and open
and own warranted fix corners, with Jellybean implementing and Speedy reviewing,
linking the Sentry issue id and URL. Existing corner authority and merge gates
still apply. Ruby receives only blocked or needs-decision reports, including
exact authority refusals. No transcript or System message is created.
Sentry text is quoted as untrusted data. Receiver failures return 503 without recursive Sentry capture.

Integration created 2026-10-18 UTC:
[Beeline triage wake](https://beeline-bt.sentry.io/settings/developer-settings/beeline-triage-wake-efb45b/),
UUID `efa4fa03-8ba9-4433-b746-e1407ff79b9e`, installation UUID
`9c0ec5c2-4b76-4e33-a44b-3c438ce9741f`. It is alertable and subscribes to issue
webhooks; only Created and Unresolved were selected. The client secret is vaulted
as **Beeline triage webhook client secret** under `sentry-triage-webhook`.

**No alert rule is needed:** the internal integration's `issue.created` and
`issue.unresolved` webhooks provide the new-issue and unresolved deliveries regardless of substatus.
Skip creating an alert workflow; the earlier HTTP 403 on alert creation is not
a blocker. No new alert id exists or is required. Existing Telegram alert
`6181673` stays independent.

**Setup complete, pending deployment:** Ruby confirmed that the integration's
client secret was rotated and its replacement stored in the existing
`sentry-triage-webhook` vault entry. The replacement is staged on Fly app
`beeline-server` as `BEELINE_SENTRY_CLIENT_SECRET`. It is staged only, not
deployed. The earlier API rotation refusal is resolved by this completed setup;
no secret value belongs in the repository or proof. Jellybean performed no Fly
staging. Production activation remains a follow-up for the next normal release.

**Production proof remains pending the next release:** after deployment, use
Sentry's send-test-notification action and verify Jellybean receives the digest in
issues-triage. Do not dispatch a release for this work. Local reproduction
`sentry-no-wake` posts signed HTTP requests to the actual server and inspects
private commands, including competing workers against isolated PostgreSQL.
Run the PostgreSQL proof with `BEELINE_SENTRY_TEST_POSTGRES_URL` set to an isolated
loopback database and `npm test -w @beeline/server -- src/sentry-wake.test.ts`;
each test owns and removes a separate schema. Without that variable it uses
PGlite.

## Mobile source maps

Metro adds a debug ID to each bundle and its source map. EAS Update 22.2.0
exports composed Hermes maps; `scripts/ota-release.mjs` uploads the exact export
once per platform before reusing it for older runtimes. Uploads name the full
release SHA, matching `EXPO_PUBLIC_BEELINE_RELEASE_SHA` in the app. Debug IDs
distinguish Android, iOS, OTA and embedded bundles even at the same SHA. An OTA
upload failure emits an Actions warning and does not prevent publication.

The Expo Sentry plugin wraps the native Android Gradle and iOS Xcode bundle
steps, uploading their composed maps with `SENTRY_RELEASE` set to the same full
SHA. Native initialization and autolinking stay disabled. Xcode native debug
symbol upload is disabled in CI because this integration captures JS errors
only. The fingerprint policy excludes this build-only plugin; runtime pins
stay unchanged.

CI setup: securely transfer the vault entry **Beeline release token (beeline-bt
org:ci)** into repository Actions secret `SENTRY_AUTH_TOKEN`. The personal
GitHub connection needs repository Actions secrets access. Do not print or
copy the token through an agent prompt. Missing credentials warn for OTA and
fail native uploads.
