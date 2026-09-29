# Agent workflows

A skill describes work within one agent turn. A workflow describes the roles, states, and transitions that coordinate several turns. Definitions use the `WorkflowDefinition` v1 contract in `@beeline/api-contract/workflows`. The validator rejects unknown roles, unreachable states, unbounded cycles, missing timeout edges, and out-of-range retries or deadlines. Each agent step declares the required types of its structured output.

The current change establishes the definition and output boundary. It does not schedule runs, wake agents, persist a run log, execute script hooks, or replace existing corner routing. Those operations require a server dispatcher and storage before a workflow definition can be used in a Room.

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
