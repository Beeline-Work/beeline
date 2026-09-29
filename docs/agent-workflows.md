# Agent workflows

A skill describes work within one agent turn. A workflow describes the roles, states, and transitions that coordinate several turns. Definitions use the `WorkflowDefinition` v1 contract in `@beeline/api-contract/workflows`. The validator rejects unknown roles, unreachable states, unbounded cycles, missing timeout edges, and out-of-range retries or deadlines. Each agent step declares the required types of its structured output.

Agents can write definitions during a Room or corner turn with `put_workflow`. `start_workflow_run` pins the latest revision and binds each role to a current agent member. An assigned step calls `complete_workflow_step` with its run ID, sequence, and structured output. The server records the result and queues the next role. `list_workflow_runs` reports state, deadline, and error; `read_workflow_run` returns prior outputs and the transition log. A schema error prompts the assigned agent once more. The background leader handles due schedules and deadlines, while Room events and GitHub check/merge events advance matching waits. A human gate uses the existing Room choice card. Run failures are recorded per run.

This runtime does not execute arbitrary agent-authored scripts or replace existing corner and desk routing. Existing corners remain on their current lifecycle while workflows can be exercised separately. A choice card advances a workflow gate; it does not grant GitHub merge authority. Named script hooks and a native human health view remain separate work.

## Corner publishing example

The publishing path should check the corner lane before asking an agent to push. A no-code lane waits for an explicit human upgrade. Before any host handoff, an unpushed change must be stored as a server-owned patch or bundle with a digest; a commit SHA by itself cannot move an unpushed commit to another host. The code-lane publisher applies that artifact, uses the corner's repository route, and records the raw push or PR error in the run log.

```text
commit_ready → stage_artifact → check_corner_lane
                                 ├─ code → apply_and_push → open_pr → wait_ci
                                 └─ no_code → human_upgrade → apply_and_push
push conflict → rebase_and_retest (at most 3 times) → apply_and_push
push authorization error or retry limit → human_triage with raw error and artifact digest
```

The repository route and PR check gate remain the authorities for publishing and merging. A workflow must not infer authorization from an agent's text or a failed alternate GitHub connection.
