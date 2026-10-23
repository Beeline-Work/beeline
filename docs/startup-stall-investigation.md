# Startup stall investigation

Investigated October 23, 2026. This change supplies missing diagnostics under
the brief's expired-log fallback. It does not claim to repair the historical
failures or add another retry.

## Evidence and limits

Read-only production command and turn records separated two paths:

- One message reached Pi session creation and model selection on each attempt.
  The local host journal records watchdog termination of the shared helper
  during all three attempts, followed by a final stalled turn. The logs do not
  identify the hosted agent or reconciliation operation holding the watchdog
  barrier. This is evidence of interrupted execution, not proof of a provider
  sign-in fault or the underlying cause of the watchdog stall.
- A starter helper connected and claimed three queued commands, then Pi
  rejected authentication. Later commands succeeded. The original Fly startup
  logs are outside the retained pages available during this investigation.
  The legacy model environment defect already repaired by PR #2796 is a
  candidate explanation, not a proven attribution for this incident.

The second machine's retained logs from October 23 show receipt requests timing
out, followed by output-authority rejection and a dropped turn. Subsequent
registration attempts received `registration_failed`; sleep requests also
timed out. That code denotes an internal server exception, not a provider
authentication verdict. The corresponding server log window is no longer
available. These observations establish a transport/server interruption but do
not distinguish database contention, server overload or a network failure.

Fly log reads use the owner's vaulted org-deploy key with
`Authorization: FlyV1 ${SECRET}` at
`https://api.fly.io/api/v1/apps/<app>/logs`. A Bearer header returns unauthorized
on this route. Filter by `instance` and page with the returned `meta.next_token`.
No production configuration, account, agent or database row was changed.

## Diagnostics for the next occurrence

The existing local watchdog tick now logs once when its preceding progress
barrier remains unresolved. Only pending agent IDs are included, with their
reconciliation stage and time spent in that stage. Stages distinguish bootstrap,
pending intake, repository changes, Room intake, corner listing/intake, shutdown
and storage cleanup. Completion or failure resets the stage to idle. The warning
does not feed the watchdog, start a second probe or extend its deadline.

Machine registration exceptions retain their existing error message and add
agent ID, authentication/session/presence stage, elapsed time and helper source
SHA. The daemon token and user content are not added to the log. Existing stalled
turn notices, authority fences and retry limits remain in force.
Read-only inspection confirmed existing failure-notice cards for the affected
paths; this change adds no new user-facing status vocabulary.

## Reproduction and demonstration

`startup-diagnostics`: the historical defect cannot be reproduced exactly from
expired logs. The stand-ins are a blocked bootstrap on an isolated helper core
and an authentication exception on a real local machine WebSocket. Previously,
the watchdog supplied no pending-stage evidence and the registration exception
had no agent/stage correlation. Regressions check the diagnostic appears before
watchdog expiry without renewing liveness, and that registration refusal logs
correlation without the daemon token.
The built-service demonstration sent a registration frame over an actual local
WebSocket and observed `registration_failed` alongside the authentication-stage
log. An isolated built helper blocked in bootstrap emitted its diagnostic after
41 ms with an accelerated local tick, fed the watchdog zero times, and reset to
idle after cancellation. The accelerated tick is a stand-in for the production
watchdog interval; the production deadline was not changed.

`cold-beebee-first-reply`: a fresh local identity created a Workspace through the
phone API, sent its first mention, received a working indicator through the
phone live socket, and received the committed reply. The isolated run on
October 23 measured 144 ms to the indicator and 28,930 ms to the reply. The real
server, helper, Pi, command claims and model proxy ran; Docker substituted for
Fly and a deterministic local streaming model substituted for the provider.
The image started with helper SHA `785cadd6c` and refreshed through its installer.
This successful path did not reproduce either historical failure. Its database,
account and containers were disposable, and the harness removed them afterward.
