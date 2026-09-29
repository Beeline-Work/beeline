# Agent workflows

A skill describes work within one agent turn. A workflow describes the roles, states, and transitions that coordinate several turns. Definitions use the `WorkflowDefinition` v1 contract in `@beeline/api-contract/workflows`. A definition declares successful terminal states. `check_workflow` reports named errors, the longest execution path in milliseconds and agent turns, and paths that end outside success. The duration excludes queue delay. `put_workflow` runs the same check before saving. Step skills must be active in the workspace catalog; bound roles must be current Room agents when a run starts.

Agents can write Room drafts during a Room or corner turn with `put_workflow`. `list_workflows` and `read_workflow` resolve built-ins first, then workspace publications, then Room drafts; an explicit layer and version can select a shadowed definition. `publish_workflow` presents the exact draft to a human on a choice card. An approval creates a new immutable workspace version that another Room can list and run. Each turn includes a short list of available workflows and open runs.

`start_workflow_run` pins the selected definition and binds each role to a current agent member. A Room draft whose bound exceeds 30 minutes or 10 agent turns, or whose steps declare merge, order, or external-write effects, waits for human approval. Published and built-in workflows have no extra workflow start gate. An assigned step calls `complete_workflow_step` with its run ID, sequence, and structured output. Its mapped input is included in the wake note. The server records the result and queues the next role. `list_workflow_runs` reports state, deadline, and error; `read_workflow_run` returns prior outputs and the transition log. A schema error prompts the assigned agent once more. The background leader handles due schedules and deadlines, while Room events and GitHub check/merge events advance matching waits. A human gate uses the existing Room choice card. Run failures are recorded per run. The server caps a run at 100 agent turns and a workspace at 1,000 workflow turns per UTC day.

Existing corners remain on their current lifecycle while the built-in `code-corner` workflow records shadow wake comparisons. A choice card advances a workflow gate; it does not grant GitHub merge authority. A human Room member can jump a live run to a nonterminal state, reassign a role to a current agent member, or kill it through `overrideWorkflowRun`; each action and actor is recorded in the run log. Named script hooks and a native human health view remain separate work.

For a code-corner review loop, the built-in wait listens for `check-completed` on the corner's current PR head, routes success to review and failure back to implementation, and caps both CI and review handbacks. The server emits `check-completed` with a `success` or `failure` outcome when the corner's checks change state. An old-head event cannot advance the wait. The existing exact-head merge gate stays in charge of merging.

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
