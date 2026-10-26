# Server-side turn replay

Terminal receipts from the Room and corner loops carry a content-free projection of
`TurnTrace` into `agent_turn_traces`. DMs use the Room loop. No new agent tool or
phone telemetry is involved. This is the foundation for later daily analysis;
this change does not schedule analysis.

The key is `(room_id, request_id, agent_id)`. `trigger_message_id` is the existing
message reached through the command's root source, or the request ID when that
is a message. It is null for a wake with no message. Private orders remain in
the existing command ledger; their text is never copied into diagnostics.
`reply_message_ids` contains committed, visible messages/cards by that agent in
that place with that request ID, ordered by timestamp and ID. Activity rows are
excluded. An empty array means no durable reply, not necessarily a failure;
consult `agent_turns.completion_kind` and the outcome. Server-authored handoff
cards and live drafts are not agent replies. IDs are references rather than
foreign keys so diagnostics never prevent message deletion.

`outcome` is the server's terminal status. `trace.totalMs` is the helper's
monotonic elapsed time before its receipt. `trace.attempts` carries retry order,
phase timings in milliseconds, and ordered `tools` with `name`, `outcome`,
`durationMs` and an optional redacted error excerpt. Phase names match
`turn-trace.ts`; tool work overlaps model time. Missing phases did not run.
Tool duration runs from the first observed call notification until its terminal
notification; a terminal-only notification has zero observed duration.
`unfinished` means no terminal result was observed (or the tool was cancelled).
ACP descriptions that are not tool identifiers become `unknown`, so shell
commands and descriptive titles cannot become diagnostic tool names.

Arguments and message text never enter the trace. Successful tool outputs are
never stored. Error excerpts redact emails, URLs, token-shaped values and named
secrets before truncation to (160) characters, both on the helper and again on
the server. The server whitelists all fields. The wire projection caps attempts
at (20) and calls per attempt at (2,000); larger attempt sets are dropped.

The reply is published first. Diagnostics share the existing receipt transaction
with a savepoint: a diagnostic insert failure drops the trace and logs one line,
without failing the receipt. Cancellation accepts diagnostics only from the
stopped generation, without changing its status or restoring output authority.
Existing local JSONL traces remain available. Network loss or helper termination
can leave a durable turn without diagnostics; absence is unknown, never an empty
successful trace. Join from `agent_turns` when measuring coverage.

Maintenance expires diagnostics after (30) days in bounded batches through the
existing jobs loop. Deleting a room cascades to its traces. Turn and message
history keep their existing lifetimes.

## Last day without a durable reply

```sql
SELECT t.room_id, t.request_id, t.agent_id, t.trigger_message_id,
       t.outcome, a.completion_kind, t.trace->'attempts' AS attempts
FROM agent_turn_traces t
JOIN agent_turns a USING (room_id, request_id, agent_id)
WHERE t.created_at >= now() - interval '24 hours'
  AND jsonb_array_length(t.reply_message_ids) = 0
ORDER BY t.created_at DESC;
```

Join `rooms` on `room_id`: a nonnull `parent_id` identifies a corner;
`direct_participants` identifies a DM. More than one reply uses the same query
with `jsonb_array_length(...) > 1`. Failures use `outcome = 'failed'`.
Slow phases can be selected by expanding `attempts` and testing, for example,
`(attempt->'phases'->>'activation')::numeric > 5000`.

## Refused tools by name in the last day

```sql
SELECT tool->>'name' AS tool_name, count(*) AS refusals
FROM agent_turn_traces t
CROSS JOIN LATERAL jsonb_array_elements(t.trace->'attempts') attempt
CROSS JOIN LATERAL jsonb_array_elements(attempt->'tools') tool
WHERE t.created_at >= now() - interval '24 hours'
  AND tool->>'outcome' = 'refused'
GROUP BY tool->>'name'
ORDER BY refusals DESC;
```

## Isolated service proof

Run `npm run prove:turn-replay` to build workspaces and replay the Room and corner
paths through built turn loops and server services, then read the reply through
the phone API and query the diagnostic row. The harness responses are scripted;
the database, command claims, refused output write, reply publishing and phone
projection are real. This does not claim a production rollout or a live model
session. The same suite covers silent/multiple replies, write failure isolation,
cancellation authority and retention.
