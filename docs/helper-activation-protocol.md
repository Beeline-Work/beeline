# Command activation context

Activation negotiates its protocol on the existing machine socket. The database migration installs compact Workspace authority heads and source triggers; a native runtime number does not establish protocol support.

A claimed durable command owns setup. Its identity includes the agent, Room,
Workspace, command ID, generation and actual authenticated connection ID/epoch.
Body requests `readCommandActivation` only through its existing machine socket.
Generic daemon HTTP and generic Body operation dispatch refuse this route. A context parks after capability loss rather than falling back to HTTP.

The server runs the existing configuration, Workspace roster, grant, repository
and optional corner setup readers in one repeatable-read, read-only transaction.
The reader has no provider or credential callbacks. The complete transient DTO
includes a Workspace authority head, command provenance digest and earliest
included grant expiry. Its serialized envelope is bounded to 256 KiB; overflow
refuses instead of truncating or splitting the context into follow-up reads.

The final enqueue holds the actual agent, connection, command and authority
rows through the synchronous socket send. It rechecks membership, command
provenance, generation, lease, source revision and grant expiry. A refused
capture produces a content-free error and does not initiate another read.

Source counters cover configuration and roster fields on agents/identities,
membership and Workspace visibility, Room repository/access state, grants,
app routes, connector routes, free-agent setup and corner briefs/facts/holds/
merge approvals. Old and new audiences are captured on moves or reassignment.
Usage, lease, progress and ordinary metadata timestamp writes do not invalidate
setup. Workspace heads contain only generation/revision, and reads never create
them. The context, source command text and granted script bytes never enter the
live journal or command ledger.

Body's actual Room and corner configuration, roster, grant, repository and
setup getters share one in-memory promise per command and connection. Repeated
consumers join both success and failure. A new claimed command or actual
authenticated connection permits one new capture. Expiry refuses reuse without
arming a refresh timer. Only one latest context is retained per loop; the socket
adapter bounds correlated pending requests to sixteen per agent.

This setup value grants no tool authority. Existing tool-time gates still read
current command and grant state. The current reviewer head/check read and an
explicit close-control read retain their existing authority paths, independently
of setup reuse. A previously held grant cannot be spent after revocation.

Targeted proofs cover the real DB-only readers, pure read-only capture,
source/provenance/expiry refusal, actual machine registration/codecs/enqueue,
HTTP refusal, actual monolith getters and zero-fetch selected Body transport.
The opt-in PostgreSQL proof checks a repeatable-read cut across a concurrent
writer and final authority locking behind a committed revoke. Released-helper
and native cohort evidence, source dependency closure under every real writer,
and equal-workload statement/WAL/CPU budgets remain rollout gates. These tests
do not establish provider exactly-once execution or zero total transport cost.
