# Owned free-agent model path: unselected

The existing endpoint accepts a separate `bfmc_v1` credential namespace only
when an injected owned-model capability is ready. Missing capability and
malformed owned tokens fail before legacy authentication or metadata reads.
No bootstrap, claim, installed Body or runtime capability selects this path yet.

The credential binds the current command generation, request, Room, Workspace,
owner, agent, connection epoch, server instance, model and token generation.
The attempt ledger reserves real quota atomically with UNKNOWN and immutable
request digests. It stores no prompt, tool arguments or generated output.
Repeated identities never dispatch again. A single existing fetch leaf serves
both cohorts; the owned branch cannot enter legacy402 retry behavior.

The final locked current-authority check hands off synchronously. Provider work
is not awaited under the authority lock. Lost response, missing valid usage,
partial stream or missing terminal delimiter retains UNKNOWN and the original
reservation. Only proven nonentry, classified provider refusal, or complete
usage evidence can settle it. Settlement uses the actual quota/budget and
model_usage tables once. The owned branch does not invoke the separate legacy
Room warning writer without a current-authority adapter.

Central validation passed: credential16, attempt12, actual HTTP/quota13,
PostgreSQL9, legacy endpoint62, and server typecheck. Real PostgreSQL proofs
include actual bootstrap rotation and retirement writer contention. HTTP
proofs use a synthetic loopback provider or explicit mock transport. No owner
Workspace, live provider, production lifecycle or schema installation was used.

Open activation gates: claim/installed Body credential delivery; Pi context and
retry ownership; pinned image modality evidence (current path is text-only);
current-authority owner-warning delivery; permanent-record storage policy and
whole-workload/WAL/compatibility proofs. These tests do not close the complete
model-route finding or authorize rollout.
