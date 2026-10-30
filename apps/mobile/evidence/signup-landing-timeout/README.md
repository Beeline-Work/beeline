# Signup landing timeout recovery

Reproduction SIGNUP-LANDING-1.

The production observation was Android build 140, OTA v0.1.121
(e4a001d2), after a brand-new Google sign-in at 2026-10-30 03:19:55 UTC.
The screenshot shows the deck's connection error and Retry. Manual Retry
then opened Create Workspace. The saved device log contains no request
failure diagnostic, and the mobile Sentry events query for 03:19–03:22 UTC
returned no events. Those sources do not establish the original network cause.
The local ADB device list was empty during this investigation; the production
OAuth flow was not repeated with a fresh identity.

## Stand-in path

Run from `apps/mobile`:

```sh
npx vitest run 'sources/app/(app)/beeline/channels.live.test.tsx' -t 'New sign-in workspace landing' --maxWorkers=1
```

Mount the actual workspace deck with a signed-in identity, no active workspace,
and no cached workspaces. At the authenticated HTTP boundary, reject the first
workspace request with `MonolithRequestTimeoutError`, then return a successful
empty workspace response. The demonstration uses the real `RoomViewClient`,
response guard, surface cache interface, refresh scheduler and rendered deck.
Only native/platform dependencies, persistence, navigation and HTTP are test
adapters. The route assertion records the app's navigation into
`/beeline/community`, whose visible first action is Create Workspace.

Before the fix, the transient-timeout regression failed: the deck never
navigated to `/beeline/community`; its initial failure required manual Retry.
After the fix, the initial timeout triggers one recovery request and reaches
that route with no Retry error surface. This is a deterministic stand-in,
not proof that a timeout caused the original production incident.

The companion cases verify that consecutive timeouts still produce the
connection error, manual Retry recovers, and a forbidden response receives
no automatic retry. No workspace is created or inferred from a failed read.
The same deck is used after both Google and GitHub authentication.

The existing community screen tests exercise the Create Workspace action and
workspace entry. Transport tests verify body-stall deadlines and timeout
classification. Recovery is confined to the first workspace discovery and
can add one request deadline before a persistent outage becomes visible.
