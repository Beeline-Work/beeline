# Push backlog recovery

`R-PUSH-BACKLOG` reproduces an unread DM waiting behind ineligible system notes.
Production read-only checks on 2026-10-22 found about 53,000 queued device rows,
about 40,000 of them GitHub corner notes for Attention recipients. Only 47 claims
completed or began in the preceding hour (about 0.013 claims/second). These notes
never qualify, but the old worker moved them forward one minute indefinitely.
It stopped its immediate drain whenever a batch claimed nothing.

The candidate membership join also expanded unrelated Room memberships per
queued device. EXPLAIN ANALYZE over the same 100 production IDs measured:

| Selection | Planning | Execution | Rows examined per execution second |
| --- | ---: | ---: | ---: |
| Original join | 23.550 ms | 1,792.795 ms | 55.8 |
| Device-and-Room lateral lookup | 123.978 ms | 26.595 ms | 3,760.1 |

Both selected no deliverable candidates. These are selection rates, not provider
throughput. A production suppression probe with real IDs took 0.490 ms and did
not compile JIT. PR #2812's global JIT change was still pending; this worker uses
`SET LOCAL jit=off` in its selection and batch-suppression transactions itself.
Fly logs were reachable through the authenticated REST logs endpoint. The sampled
window contained slow database queries but no push/background exception; it did
not establish a complete worker-cycle rate.

The worker drops expired rows in bounded batches before selection, checks each
leased expiry again immediately before calling the provider, and retires
ineligible notes. It retains work that can become eligible without a message
write: working turns, retries/active claims, disabled platforms, Off recipients,
and Attention prose or workspace-join notices eligible after a switch to Full. Updating a message can
transactionally enqueue it again. Excluded card types no longer fan out on writes.
Other non-prose messages enqueue
only for recipients covered by the shared direct-attention policy; ordinary
GitHub notes produce no device rows, while a note replying to the recipient still
qualifies. Prose remains queued for later preference changes.
Room access, direct attention, mute, presence, and read rules stay authoritative.

Preference-ineligible rows now wait until their expiry rather than retrying every
minute. The existing `person_push_outbox` trigger wakes them transactionally when
push preferences change. Disabled platforms retain their timed retry, provider
claims retain their own backoff, and a concurrent preference or turn write keeps
its new deadline. Expired and ineligible retirements are recorded in
`push_outbox_retirements` with a reason, separate from delivery claims so a later
message edit may still qualify. Evidence is retained for an hour and cleaned in
bounded batches; existing terminal delivery claims remain authoritative.

Each cycle processes at most ten batches, including zero-claim batches, before
yielding to other jobs. Existing collapse IDs remain in use; distinct direct
attention and permission requests keep their separate identities. No broad
per-device collapse is introduced because that would discard unrelated asks.

## Proof

Run the package command to build the affected service and exercise the proof:

```sh
npm run prove:push-backlog
```

The built service runs against an isolated PGlite database and a provider stand-in.
It inserts 200 ineligible notes, 1,100 expired rows, then an unread DM. The original
worker made no provider call and left 1,201 rows after its first cycle; the fixed
worker delivered only the DM and left no queued rows (about 5,379 rows/second on
the measured local run). This is not a device or production-delivery proof.
`push-outbox.test.ts` additionally covers suppression parity, expiry while waiting
to send, fanout exclusions, retries and real PostgreSQL migration-lock handoff.
A frozen executable pre-fix selector (`test-fixtures/push-selection-before-backlog.sql`)
independently checks the enqueue and retirement matrix: every originally eligible
row survives enqueue filtering and every retired row is absent from that selector.
The matrix also verifies preserved delivery after preference changes and turn completion.

## Production follow-through

Merging does not release. After the authorized server release, use the existing
vault database route for read-only observations:

```sql
SELECT now(), count(*) total,
  count(*) FILTER (WHERE not_before<=now()) due,
  count(*) FILTER (WHERE expires_at<=now()) expired
FROM push_outbox;

SELECT status, count(*) FROM push_delivery_claims
WHERE claimed_at>=now()-interval '5 minutes' GROUP BY status;
```

Verify the backlog decreases, expired rows disappear, and a newly sent unread DM
reaches the recipient's actual device. Record the observation interval and the
change in terminal claims for actual production rows/second. Do not manually
DELETE production rows as part of this runbook; the bounded worker owns cleanup.

A due backlog over 1,000 rows emits `Push outbox backlog exceeds 1000 due rows`
through Sentry, tagged `background_job=push` and `signal=push-outbox-backlog`.
The worker samples at most once a minute, even when no candidates qualify.


## BEELINE-SERVER-17 follow-up

Read-only production SQL on 2026-10-25 at 03:53 UTC found a queue of
(1,256 rows), with no due or expired rows at that instant. All rows lacked a
claim: Attention prose on Android (1,141 rows across 50 devices), web (69 rows
across 3 devices), iOS (23 rows on 1 device), and Off prose on iOS (23 rows on
1 device). Messages spanned 02:57–03:52 UTC. Recent claims showed delivered
(33) and suppressed (3), so this was not a complete delivery outage.

At 03:56 UTC, the shared direct-attention SQL confirmed all retained rows were
not direct attention: Android Attention (1,241), web Attention (75), iOS
Attention (25), and iOS Off (25). The prior fix intentionally retained these
messages for preference changes but rescheduled them every minute, repeatedly
spending eligibility batches on work that cannot qualify until a write.
The latest Sentry event remained 2026-10-24 15:51:45 UTC on release `22d7abec6b91`.
These observations identify the current repeat-work class; they do not establish
the queue composition at the historical alert instant.

The same `npm run prove:push-backlog` command now also exercises
`BEELINE-SERVER-17` through the built worker and a provider stand-in. Before the
fix, ordinary Attention prose recurred after one minute (1,100 rows). After the
fix, recurring rows were (0), a fresh unread DM reached the provider in one
cycle, and a change to Full woke all retained rows (1,100) and delivered prose.
The tests additionally prove Off expiry records its reason without sending stale
messages and retirement evidence does not prevent an edited message delivering.
This is the closest isolated stand-in: production writes and a real device push
were not performed during the read-only diagnosis.

After release, observe due rows over a sustained interval and confirm a real
unread DM arrives on a device. Total retained rows may exceed the alert threshold;
parked rows must not repeatedly become due before a preference change or expiry.
Count retirement reasons with:

```sql
SELECT reason,count(*),min(retired_at),max(retired_at)
FROM push_outbox_retirements GROUP BY reason;
```

Production recovery remains unverified until that release and observation.
