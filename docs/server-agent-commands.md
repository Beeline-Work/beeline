# Server-owned agent commands

`apps/server/src/agent-command.ts` is the routing authority. `agent_commands` records source, target, action, reason, root/parent, depth, lease, generation and result. `agent_turns` remains the execution receipt authority.

Human tags, stored replies to agents and direct messages create commands in the message transaction after current membership and policy checks. Presence can shape the offline notice shown to the sender, but never gates command creation: the pending command survives a disconnected helper and is claimable after it returns. An exact agent tag in a committed agent reply dispatches that agent; final storage and the next command commit together, with targets derived from the stored message's validated mention IDs. A stored agent reply is addressed only within its current chain. Human intent starts depth zero; delegated depths one through three are allowed, and depth three cannot dispatch another agent.

Both helper loops consume only `getAgentCommands`, claim with a session generation, and queue inputs while busy. Stop commands may interrupt a running prompt. Live notifications wake a command read; they never authorize work. The existing transcript reads and model sessions supply context and execution machinery.

A claim leases a command for 90 seconds. Matching working receipts renew it. A crashed helper's expired command can be reclaimed; the old generation's outputs are rejected. Final retries return the stored result, and completed/cancelled commands cannot reopen. Draft, thought, activity, attachment and final writes require the live claimed request and generation.

Schedules, event subscriptions, corner objectives/check changes, grant decisions and cancellation produce explicit input/resume/stop actions. Resumptions retain the original request and root; check-state commands are coalesced by stored lifecycle state.

Mixed versions fail closed. The legacy inbox projects targeted commands only. A legacy working receipt can claim its projected command with a generation, but writes lacking generation authority are refused. A new helper refuses a server without command protocol 1; it never falls back to shared traffic. Upgrade helpers together with the server to retain full output functionality.

## Pairing-proof setup regression

The exact first-presence test in `daemon-api-client.integration.test.ts` passed on both the PR and clean current main (`5dfa1d95329d433e41f6c87b9acdb21f33f4c8d1`) via the Body workspace script, but failed on both from repository-root `vitest --root apps/body`. Its child log showed `MODULE_NOT_FOUND` for repository-root `dist/cli.js`, before server registration. The fixture now resolves the built CLI relative to its own module. The same live pairing, token exchange, daemon launch, first presence and final-answer assertions then passed on both branches under the previously failing invocation. No assertion or timeout was weakened.

Build Body before running the pairing proof. Focused gates cover API-contract, server command/integration tests, Room/corner Body tests, Body/server integration, and all three workspace typechecks. Production agents and no-mistakes are not invoked by this task.

## Verification

- API-contract: 59 passed.
- Body: 742 passed, 8 skipped, including the original live pairing proof.
- Focused server: 196 passed, 7 failed. The failure-name set exactly matches the clean current-main control below; the command boundary and changed routing fixtures pass.
- API-contract, server and Body typechecks: passed.

The unchanged failures reproduced on main `5dfa1d95329d433e41f6c87b9acdb21f33f4c8d1` are:

- `src/integration.test.ts > monolith integration > always hands an agent its seeded soul, at both daemon seams (no Workspace switch)`
- `src/integration.test.ts > monolith integration > keeps workspace and Room mutations aligned with the phone HTTP contract`
- `src/integration.test.ts > monolith integration > lets an agent subscribe itself, and wakes it on the next arrival`
- `src/integration.test.ts > monolith integration > publishes one note per joined Room and one push through agent connect`
- `src/integration.test.ts > monolith integration > rejects agent names without an addressable handle`
- `src/integration.test.ts > monolith integration > routes a Workspace join to one attributed @system DM and no shared Room lines`
- `src/system-line.producers.test.ts > system-line producers > writes one Room visibility line for concurrent identical updates`

These failures are reported, not waived or described as a passing server gate. The protocol changes do not repair those unrelated membership, identity and visibility assertions.
