# Invite redemption deadline reproduction

On 2026-11-02, the production v0.1.133 server verified the authorized Play
Review invite to Tubing Crew in 72 ms, but `redeemInvite` did not answer within
the diagnostic client's 25-second deadline. During that request,
`pg_stat_activity` showed its Room membership INSERT executing for 14.8 seconds
without a lock blocker. Afterward, read-only queries found no membership and
an unconsumed invite. No production database mutation or deployment was used
to repair the failure.

`REVIEW_LOCKED_OPERATIONS` does not include redemption. Both an ordinary
identity and Play Review can join locally without changing that security guard.
The phone sends redemption through `/v1/phone/live`; its previous deadline was
20 seconds, shorter than the server's 30-second transaction deadline. The
original emulator's first socket closure was not reproduced identically; the
independent socket probe reproduced the unanswered join.

The membership INSERT fires `corner_owed_member_changed`. Its bulk query
materializes child-history candidates and probes the person's latest answer
for each candidate. Production had approximately 565,000 messages under the
target Room's child corners, including 18,000 recent messages. The answer probe
had no Room-and-author index; production EXPLAIN selected a Room-history bitmap
scan. Rooms without child corners also evaluated the bulk history query.
The legacy compatibility trigger does not fan a new Room membership into
corners. The companion
[corner-membership cleanup](https://github.com/Beeline-Work/beeline/pull/3249)
still fails the answer-buffer regression on its own.

The fix builds `messages_room_author_answer_idx` concurrently, covering
`(room_id,author_id,created_at DESC)` for undeleted conversation messages, and
skips the bulk refresh when the Room has no children. Cross-Room report refreshes
still run. The phone waits 40 seconds for redemption and confirms an ambiguous
result once with the same token. If confirmation is also inconclusive, it says
the join is unconfirmed and offers a safe retry.

`invite-join-deadline.test.ts` now includes actual child history and recent
messages. On isolated loopback PostgreSQL, the absent-answer probe failed
before the fix at 471 buffers and passed afterward at 3. With 565,000 messages,
joins at 10/1,000 corners improved from 6.85/3.61 seconds to 1.06/0.96 seconds.
These are synthetic local measurements, not production latency guarantees.

`invite-socket.integration.test.ts` uses real authentication and WebSockets to
prove normal and reviewer membership, Room reads, and confirmation after a
committed join loses its response. A browser harness against the built local
server also joined both identities and displayed each as a Room member: 48 ms
for the ordinary identity and 34 ms for Play Review. This is a browser/socket
proof, not a rebuilt Android application or a production repair.

Run the focused suites separately with `--maxWorkers=2 --minWorkers=1`:

```sh
# From apps/server; the optional URL must name an isolated loopback database.
BEELINE_INVITE_TEST_POSTGRES_URL='<loopback URL>' npx vitest run src/invite-join-deadline.test.ts --maxWorkers=2 --minWorkers=1
npx vitest run src/invite-socket.integration.test.ts --maxWorkers=2 --minWorkers=1
npx vitest run src/corner-owed.test.ts --maxWorkers=2 --minWorkers=1
# From apps/mobile:
npx vitest run sources/sync/transport/monolith-operation.test.ts --maxWorkers=2 --minWorkers=1
```
