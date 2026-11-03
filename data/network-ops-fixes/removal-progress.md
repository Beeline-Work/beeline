# Router removal progress

Instruction 045 retains the individually justified `live.notify` owner exception
and resumes deletion of parallel paths. The router remains capability-off in the
combined branch. The complete post-switch removal and empty boundary sweep are
still required; these deletions do not claim complete route ownership.

## Server: 20 to 18, equal to main

The 60-second receipt polling implementation is deleted. Contract approval and
final swap receipt observation now share the single-attempt adapter whether or
not the old caller sends `completionV1`. An unconfirmed approval returns the
existing pending outcome with its identity and never submits its dependent call.
Provider-first and later completion remain owner/chain/hash-bound. Other
capability-specific broadcast semantics are unchanged; full old-helper/client
compatibility is not inferred from these selected operation proofs.

Scheduled Work's existing authority query now covers requested IDs even when a
Room was deleted. It returns the principal certificate at the same statement
snapshot as surviving Room policy. The audience no longer issues a second
certificate query. Missing principal evidence still refuses; content-free
unavailability and the final enqueue fence retain their existing semantics.

Passing focused proofs: CDP completion 28 (with and without capability), chain
regressions 21, actual wallet operations/webhooks 4 (35 unrelated cases filtered),
authority audience 8 including deleted-Room two-query admission, and real
PostgreSQL Scheduled Work workloads 4 at 16/128 Rooms and both coverage modes.
Server typecheck passes.

## Helper: 30 to 29, equal to main

`queueInbox` no longer reads/appends/writes a separate text inbox. Every new
local message uses the same durable delivery queue as stream messages. Existing
installed-helper text is atomically renamed into that queue with an explicit
text input codec. The usual pending-to-done claim consumes it; there is no
separate text consumer. A crash on either side of adoption leaves the bytes in
one queue. Same-process local messages retain admission order within a millisecond.

Passing focused proofs: inbox adoption 3 (pending old text plus stream delivery,
restart after atomic adoption, sole new format and order), member stream 6
including durable cursor/replay, joined-session regressions 11, and Body typecheck.
These are isolated storage/operation proofs, not native helper lifecycle tests or
an exactly-once claim for delivery into third-party applications.

The existing architecture scanner has no tree/count mismatch. Against main it
still reports three relaxations: notification owner, server environment 60→61,
and phone parallel paths 19→24. No scanner, pattern, scope, allowlist or guard was
weakened. Phone path removal and the unified-switch deletion belong to the
post-switch removal build described in the release sequence.
