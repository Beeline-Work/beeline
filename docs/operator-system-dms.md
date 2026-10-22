# Operator System DMs

`send_operator_system_dm({recipients,text})` queues plain notices through the existing
System thread producer. `recipients` accepts an exact human id or handle, a list,
or `all`. Handles may have a leading `@`. The normal daemon message limit is
16,000 characters; there is no recipient cap. Duplicate recipient identities
receive one message per send.

The server authorizes the active command, resolves its human root, and requires
that root to be the immutable lunchboxfortwo operator identity in
`OPERATOR_OWNER_ID`, also present in `BEELINE_SYSTEM_SENDERS`. The authenticated
agent must belong to that same person. Copied text, another configured sender,
an agent-owned command, or a system wake cannot supply this authority.

The response contains `sendId`, `recipients`, `delivered`, `failed`, and `pending`.
Use `read_operator_system_dm({sendId})` to read subsequent counts under the same
owner-command authority. Do not repeat a pending send. A new send call creates a
new send, including when its text matches an earlier one. Delivered means the
message committed to the System thread, not that the recipient read it or an OS
push was acknowledged.

The request snapshots recipients and commits an audit plus durable delivery rows.
The background leader processes at most ten deliveries per cycle and stops
starting work after half a second. Each recipient's System message and receipt
commit atomically with a deterministic message id. A failed recipient is recorded
without cancelling others. Restarting resumes pending deliveries. Humans without
an active Workspace are counted as failed. System and other hidden service
identities, and agents, are excluded from `all`.

Audit rows retain caller, owner, source command message, audience, recipient count,
text hash and creation time. Delivery rows retain the resolved identities and
outcomes. Message insertion uses the normal PostgreSQL live and push-outbox
triggers; this path does not invent a separate notification mechanism.

## Validation

This is a feature, not a defect report. Run:

```
npm run prove:operator-system-dm
npm run test -w @beeline/server -- src/operator-system-dm.test.ts src/feedback.test.ts src/system-line.contract.test.ts
npm run test -w @beeline/body -- src/minimal-tool-surface.test.ts
npm run typecheck
```

The compiled-service proof uses an isolated in-memory database, accepts an owner
command through `DaemonService`, processes the queue, and asserts the exact text
and System author in the recipient's `PhoneService.readRoom` response. Unit and
service integration fixtures cover single, list and all sends, authority refusals,
audit records, partial failure and bounded batch continuation.

The production browser proof remains outstanding. Trusty Squire opened
`web.usebeeline.app` in the existing lunchboxfortwo session. Connectors and vault
metadata confirmed the reviewer-bypass login link, but sealed browser-fill
returned `unsupported_credential_type` for its `value` field. A live browser share
was posted for reviewer sign-in handoff. This branch has not been deployed, so the
new tool's production delivery is not claimed. After the normal authorized release,
send one notice to the authorized reviewer test account and verify its exact text
and System author in that account's System thread. List and all sends must remain
isolated-test-only during development proof.
