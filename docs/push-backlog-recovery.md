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

Each cycle processes at most ten batches, including zero-claim batches, before
yielding to other jobs. Existing collapse IDs remain in use; distinct direct
attention and permission requests keep their separate identities. No broad
per-device collapse is introduced because that would discard unrelated asks.

## Proof

After `npm run build -w @beeline/server`, run:

```sh
node --import tsx scripts/prove-push-backlog.mjs
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
