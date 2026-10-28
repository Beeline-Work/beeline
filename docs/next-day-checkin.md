# One-time next-morning check-in

New outside people become candidates when they send their first ordinary message after this migration. There is no historical backfill. At the first 09:00 Eastern morning at least twelve hours later, the background job claims one row per identity and issues `free_agent_checkin` to their starter agent in the Room of their last message. No identity time zone is stored today, so all candidates use the approved `America/New_York` fallback. The due-time helper also supports IANA zones when a stored source becomes available.

The agent receives only instructions to use that Room's visible messages and offer one next step. Its normal Room reply drives the existing push outbox and delivery worker, including notification preferences and read suppression. The worker records the push outcomes; it does not send a second push itself. Email uses the same committed message text, with a Room link and one-time footer. Only Google `identity_external_links.provider_login` addresses qualify; GitHub logins are never treated as addresses or looked up.

The scheduler excludes confirmed team handles (`lunchboxfortwo`, `bananaman614305`, `moonscannerai`), the review account, hidden identities and members of internal workspaces. It skips people who returned on a later Eastern day at least six hours after their first message, left the Room or Workspace, or removed their starter agent. Generated output rechecks these conditions and the switch. A completed turn without a reply, or a turn still unfinished a day after its due time, retires with a skip reason.

## Configuration

- `BEELINE_NEXT_DAY_CHECKIN=off` disables dispatch and email on each tick and refuses pending generated check-in replies. Default: on. Existing push outbox work retains the normal delivery authority for messages already committed.
- `BEELINE_EMAIL_API_KEY`: Resend sending key.
- `BEELINE_EMAIL_FROM`: sender on the verified sending domain, optionally `Beeline <hello@your-domain>`.
- `BEELINE_WEB_APP_ORIGINS`: the existing first web app origin supplies Room links; fallback `https://web.usebeeline.app`.

Ruby configures the provider, verified domain and Fly secrets after landing. Missing email configuration records `unconfigured` without preventing the Room message or push. Configuration does not collect any new email address.

Email attempts are committed before HTTP and never retried. A crash or unknown provider response may therefore lose an email, but cannot send a second email after restart or after the provider's idempotency window expires. `attempting` means the process did not record a final outcome; `failed_or_uncertain` means the HTTP call threw. Resend's idempotency key adds protection to the single attempt. Email and model work do not hold the push or schedule jobs open.

## Evidence and measurement

`next_day_checkin_candidates` retains the first-message time and due time. `next_day_checkins` holds the unique identity claim, Room, agent, command, committed message, send time, skip reason, email attempt/outcome and push outcomes. The existing anonymous onboarding ledger receives `next_day_checkin_sent`; exposure and channels are also directly countable from the check-in row. Push statuses come from the normal delivery claims, observed until completion or the one-hour delivery window expires. A push provider acceptance or email API success does not establish that a person read it.

Run `npm run prove:next-day-checkin`. This exercises the built services: phone send → due clock → public command delivery and claim → helper reply → phone Room read → normal push delivery → captured Resend HTTP request. PGlite substitutes for PostgreSQL, a deterministic helper reply substitutes for a live model, and local provider captures substitute for APNs and Resend. Production proof follows release. This is a feature, not a defect report.

The proof writes [the email HTML](evidence/next-day-checkin/email.html) and [captured results](evidence/next-day-checkin/proof.json). Acceptance tests live in `apps/server/src/next-day-checkin.test.ts`.
