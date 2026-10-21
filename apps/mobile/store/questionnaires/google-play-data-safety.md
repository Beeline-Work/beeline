# Google Play Data safety draft

Review this draft against the live binary and current Play Console wording at
submission time. It describes the code in this repository as of the monolith
cutover preparation; it is not a legal declaration on its own.

Developer/publisher: **Moon Rice Limited**. The active Play Console account is
`dani@trustysquire.ai`; the owner will mint its service-account key separately.

## Collection and sharing summary

| Play Console prompt | Draft answer | Reason / code authority |
| --- | --- | --- |
| Does the app collect or share required data types? | Yes | The service processes account identity, Room content, optional file attachments, and Android push registration tokens. |
| Is data encrypted in transit? | Yes | App/service calls use HTTPS/NIP-98 authenticated requests; relay traffic is configured for `https://usebeeline.app`. |
| Can users request deletion? | Yes, contact Moon Rice Limited at `hello@usebeeline.app` | Privacy policy and deletion contact for the active corporate Play account. |
| Is data sold? | No | No sale or advertising SDK appears in the mobile app. |

## Data types

| Data type | Collected | Shared | Purpose | Required? | Linked to identity? |
| --- | --- | --- | --- | --- | --- |
| Name / username / user ID | Yes — GitHub-linked handle and signed app identity | With the user's Beeline service; GitHub only for requested sign-in or repository connection | Account management, app functionality | Yes for a connected account | Yes |
| Messages | Yes — Room and task messages | With the user's Beeline service and the Room participants they choose | App functionality | Yes to use messaging | Yes |
| Files and documents | Yes, only when the user attaches/uploads them | With the user's Beeline service and recipients they choose | App functionality | Optional | Yes |
| Photos | Yes, only when selected as a chat attachment or avatar | With the user's Beeline service and recipients they choose | App functionality | Optional | Yes |
| Device or other IDs | Yes — Android FCM registration token | Firebase Cloud Messaging and the user's Beeline push gateway | App functionality: deliver optional notifications | Optional | Yes — token is registered to the signed app identity |
| App interactions (first-party sign-in funnel) | Yes in production | Beeline service only | Analytics: improve sign-in | Required in production | No account identifier in the event ledger |
| Other IDs (random install/attempt UUIDs) | Yes in production | Beeline service only | Anonymous sign-in measurement | Required in production | No account identifier in the event ledger |
| App interactions (PostHog) | Conditional — only when a build contains `EXPO_PUBLIC_POSTHOG_API_KEY` and analytics is not disabled | PostHog as a service provider | Analytics | Optional | No application-level account identity is passed by the current event calls |

## First-party anonymous sign-in measurement

Production apps send app-open, sign-in-screen, provider-tap, callback-outcome and
signed-in events to Beeline. Declare App interactions and Other IDs for analytics:
random install and short-lived attempt IDs, platform/version, timestamp, provider,
and fixed outcome/error enums. No account identifiers, names, emails, logins,
IP addresses, device names, codes or tokens are stored in these events. The
signed-in endpoint uses authentication only to exclude internal traffic. Raw
records last 90 days, followed by anonymous daily aggregates. Dev/preview/lab and
Play Review traffic is excluded. Privacy text: `web/privacy/index.html`.
This declaration is independent of optional PostHog configuration.

## Conditional analytics declaration

The code creates PostHog only when an API key is embedded and
`EXPO_PUBLIC_DISABLE_ANALYTICS` is not true. Its current explicit events are
`ota_update_available` and `ota_update_applied`, with OTA/runtime versions.
`captureAppLifecycleEvents` is also enabled. If the release environment does
not set the key, answer **No** for App interactions/analytics. If it does, keep
the App interactions row above and answer the Console's current questions for
analytics service-provider processing.

## Do not select

- Precise or approximate location, contacts, calendar, microphone, health,
  financial information, or browsing history: no corresponding collection was
  found in the mobile source.
- Crash reporting: no crash-reporting SDK was found.
- Advertising, personalization, or sale: no advertising SDK or ad use was
  found.

## Verification pointers

- Local secret identity: `apps/mobile/sources/auth/buzz-identity-storage.ts`
- GitHub identity and encrypted token storage: `apps/auth/src/github-operations.ts`, `apps/auth/src/store.ts`
- Message/file handling: `packages/buzz-client/src/attachment.ts`, `apps/mobile/sources/buzz/chat-attachment.ts`
- Android FCM registration: `apps/mobile/sources/push/buzz-push-registration.ts`, `apps/server/src/firebase-push.ts`
- Analytics gate and events: `apps/mobile/sources/track/tracking.ts`, `apps/mobile/sources/track/index.ts`
