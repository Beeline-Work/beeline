# Workflows

A workflow is a saved contract that passes work between named roles in a Room. Each step names who acts, what they must hand over, and where each outcome goes next. Runs live in the Room transcript: every step is posted as a handoff card.

A workflow does not run on a timer. It moves only when a bound agent calls `handoff` or a human answers a gate. For work that repeats (a check every few minutes, a daily start), target `create_schedule` at it with `workflowName`, and have that scheduled turn call `start_workflow`. Other agents join an existing run through `handoff` with its full run ID.

## Tools

| Tool | What it does |
| --- | --- |
| `save_workflow` | Validates a contract and saves it Workspace-wide, versioned by `name`. Saving the same name again makes a new version. |
| `start_workflow` | Starts a run of a saved workflow in this Room. You bind every role, and it returns a `runId`. |
| `get_workflow_run` | Reads a run by `runId`, including its current state, requirements, history and pinned contract. |
| `handoff` | Moves a run you hold to its next state. You give an `outcome` and the `contents` the state requires. |
| `cancel_workflow_run` | Ends an active run with a recorded reason, subject to requester, role-owner or admin authority. |
| `assign_workflow_role` | Binds any agent in the Room to a role when no agent on that role's list is healthy. |
| `archive_workflow` | Retires a saved workflow so it can no longer be started. Runs in progress keep going. |

## Contract format

```json
{
  "version": 1,
  "name": "draft-review",
  "description": "Draft a note, review it, and get a human sign-off",
  "summary": "Draft a note, review the result, and ask a person before publishing.",
  "roles": ["writer", "reviewer", "approver"],
  "start": "draft",
  "handoffs": {
    "draft": { "does": "Write the note.",
      "role": "writer",
      "hint": "the draft note",
      "requires": ["text"],
      "on": { "submitted": "review", "timeout": "stuck" },
      "timeoutSeconds": 3600
    },
    "review": { "does": "Review the note and request changes if needed.",
      "role": "reviewer",
      "requires": ["verdict", "notes"],
      "on": { "approved": "sign_off", "changes_requested": "draft" },
      "loop": { "onEdge": "changes_requested", "cap": 3, "onExceeded": "stuck" }
    },
    "sign_off": { "does": "Ask a person for permission to publish.",
      "kind": "gate",
      "role": "approver",
      "requires": ["decision"],
      "on": { "publish": "done", "reject": "failed" }
    },
    "stuck": { "does": "Ask a person how to continue.",
      "kind": "gate",
      "role": "approver",
      "requires": ["decision"],
      "on": { "retry": "draft", "abandon": "failed" }
    },
    "done": { "does": "The note is ready to publish.", "kind": "terminal", "status": "done" },
    "failed": { "does": "The note will not be published.", "kind": "terminal", "status": "failed" }
  }
}
```

### Top level

| Key | Rule |
| --- | --- |
| `version` | Always `1`. |
| `name` | Lowercase words joined by hyphens (`a-z`, `0-9`, `-`). No underscores. At most 64 characters. |
| `description` | 1-60 characters. |
| `summary` | Required nonempty plain-language overview on one line, at most 140 characters. Shown above the run’s steps. |
| `roles` | 1-16 unique role names. Lowercase letters, digits, `_` or `-`, starting with a letter. |
| `start` | The state a run begins in. It must not be a terminal. |
| `handoffs` | 2-64 states, keyed by state name. State names follow the role-name rule. |

Unknown top-level keys are rejected.

### State kinds

Every state needs a `does` sentence: nonempty plain language on one line, at most 140 characters. It describes what the step does for people reading the run, including gates and terminals.

Every state may have an optional free-text `hint` describing the outcome or artifact to attach when leaving it. The dispatched agent sees this hint in its command before calling `handoff`. A hint does not require a receipt.

**Handoff** (no `kind`): a role acts and reports an outcome.

| Key | Rule |
| --- | --- |
| `role` | One of `roles`. Required. |
| `requires` | Field names that `handoff` must include in `contents`, up to 32. Letters, digits and `_`. Use `[]` for none. |
| `on` | Outcome to next state, 1-16 outcomes. Each target must be a declared state. |
| `loop` | Optional cap on one outcome: `{ "onEdge": <outcome>, "cap": 1-100, "onExceeded": <state> }`. `onExceeded` must differ from where `onEdge` normally goes. |
| `timeoutSeconds` | Optional, 60 to 2592000. Needs a `timeout` outcome in `on`. When it elapses, the bound agent is reminded to call `handoff` with outcome `timeout`. |

**Gate** (`"kind": "gate"`): a human decides. It allows only `kind`, `role`, `requires`, `on`, `does` and optional `hint`, and needs 2-4 outcomes of at most 32 characters each. The run posts a choice card with one option per outcome. When a human answers, the role's agent is woken and calls `handoff` with the chosen outcome.

**Terminal** (`"kind": "terminal"`): the run ends. It allows only `kind`, `status`, `does` and optional `hint`, where status is `done`, `failed` or `abandoned`.

Unknown keys on a state are rejected. The `server` and `waiting` kinds, `roleBinding`, `implicitEdges` and `externalOutcomes` exist for Beeline's built-in workflows and are not needed for your own.

### Graph rules

- At least one terminal state is required.
- Every state must be reachable from `start`, by `on` targets or a `loop`'s `onExceeded`.
- Every cycle must either pass through a gate or have a `loop` cap on a state in it. In the example, `draft -> review -> draft` is capped by the loop on `review`. On the fourth `changes_requested`, the run goes to `stuck` instead.

When `save_workflow` rejects a contract, the error names the rule and where it failed, for example:

```
workflow contract is invalid: cycle watch -> risk -> watch has no loop cap
workflow contract is invalid: handoffs.approve: a gate needs 2-4 outcomes (got 1)
```

## Running a workflow

Any current agent member of the Room can start a run or create/update a schedule targeting a saved workflow; there is no per-workflow owner. The Room menu's **Workflows** entry lists saved definitions, even before their first run. The run page links to **All runs**, where starter attribution and full run IDs are visible. A human Room/Workspace admin can also start a separately attributed run through `startOwnedWorkflow`, recorded as that human.

1. **Save.** Call `save_workflow` with `{ "contract": { ... } }`. It returns `{ "slug", "version" }`. A run already in progress keeps the version it started with.
2. **Start.** Call `start_workflow` with `{ "name", "roleBindings" }`. Bind every role to either:
   - an agent id (64 hex characters) of a current member of this Room,
   - a member's handle (for example `candy`, with or without the `@`), or
   - an ordered list of up to 16 such agents. The role goes to the first healthy agent on the list (online, no failed turn in the last 5 minutes, not out of credit). That agent keeps the role unless its turn fails or goes silent; then the role moves to the next healthy agent on the list.

   The run posts a card whose message id is the `runId` and wakes the agent bound to the start state. If the start state is a gate, it posts the gate's choice card instead.

   **Every wake from a run states the run id and workflow name plainly**, including step handoffs, answered gates, and state timeouts: `You are in run <runId> of <name>. Continue this run; do not start a new one.` The handoff card also shows the full run id. Call `handoff` with that `runId` to continue. If the calling agent currently holds a role in an active run of the same workflow, `start_workflow` refuses it even when a human message woke the agent, with `You are already in run <runId> of <name>. Continue it or hand off within it.` It also refuses another agent starting that workflow from the same schedule occurrence while its run is active, naming the existing run id. A human Room/Workspace admin can start a separately attributed run through `startOwnedWorkflow`.

3. **Read and hand off.** Any agent member of the run's Room can call `get_workflow_run` with `{ "runId" }`. The response includes `workflowSlug`, `workflowVersion`, `state`, `status`, the current `role` and `boundAgentId`, `allowedOutcomes` (outcome → next state), `requiredFields`, `receiptHint` when declared, the full pinned `contract`, and `history` with actors, contents and receipts. Read this contract even if the saved definition or repository copy has since changed. Every workflow wake includes its current state and allowed outcomes, including start, handoff, gate-answer and timeout wakes.

   The agent holding the current state calls `handoff` with `{ "runId", "outcome", "contents" }`. The outcome must be one the state declares. `contents` must be an object, at most 16 KB, containing every `requires` field. A refusal lists all missing fields and all allowed outcomes with their next states together. The next state's agent is woken automatically, so no @mention is needed.
4. **Gates.** When a run reaches a gate, a choice card is posted for a human. After they answer, the gate role's agent calls `handoff` with the chosen outcome. The person may add an optional one-line note (at most 140 characters) with their pick. The wake quotes it (`Their note with the answer: "..."`), and the run page shows it under the answer. The outcome still comes from the picked option.
5. **No healthy agent.** If nobody on a list-bound role's list is healthy, the run says so in the Room and waits. A human can ask an agent to call `assign_workflow_role` with `{ "runId", "role", "agentId" }` to bind any agent in the Room.
6. **End or cancel.** The run ends when it reaches a terminal state. To stop an active run, call `cancel_workflow_run` with `{ "runId", "reason" }` (a nonempty reason, at most 4000 characters). The server derives the caller from the active turn's root requester; an agent cannot nominate someone else or borrow its owner's authority. Cancellation is allowed for the run's recorded requester, a human owner of any currently bound role agent, or a human Room/Workspace admin. Other callers are refused. The cancellation card records the actor and reason, leaves the run at its last declared state with status `abandoned`, removes its timeout and pending wakes, and closes an open gate without dispatching another agent. The run read returns `cancellation`, no allowed outcomes and no required fields. `handoff` and role reassignment on an ended run are refused.
7. **Retire.** `archive_workflow` with `{ "name" }` stops new runs of that workflow.


## State receipts and the run page

A handoff may include `receipt` beside `contents`. It does not replace the state's required contents:

```json
{
  "runId": "the-run-id",
  "outcome": "submitted",
  "contents": { "text": "The draft note" },
  "receipt": {
    "line": "Drafted the note for review.",
    "refs": [{ "kind": "file", "label": "Draft note", "url": "https://example.com/draft.txt" }]
  }
}
```

`line` is optional plaintext on one line, at most 140 Unicode characters. `refs` is optional and contains 0–3 references. Each has a `kind` (`brief`, `file`, `message`, `pr`, `checks`, `memory` or `url`), a nonempty `label`, and an HTTP(S) `url`. All workflows render these as the same typed chips. Missing lines and refs stay empty; there is no generated fallback. `{}` is a valid receipt.

The engine records `exit: { gate, actorId }` on the transition card. Agents cannot supply or override it. Receipt data belongs to the state the card leaves, including each separate visit around a loop. Existing cards without receipts remain readable.

The run page has one vertical rail with one circle per reached visit, its saved description, assignee and elapsed time. Current visits show the newest available chunk; finished agent visits show their last committed final reply, with optional receipt lines and chips alongside. Expanding a row shows timestamps and handoff details. There is no horizontal rail or previous-runs counter.

## Reading a run

The run page shows the overview from the run's pinned revision, then only reached steps in execution order. Repeated visits get separate rows. Each row shows its saved `does` sentence, responsible person or agent, and elapsed time from server entry/exit timestamps. Current time advances; completed time stays fixed. Human decisions are still answered on the ordinary choice cards in the Room.

While an agent works, its step shows the current narration run as a readable output chunk, replacing the previous run rather than displaying individual token fragments. A finished step shows its own last committed final reply, even when the agent called `handoff` before posting that reply. The server associates the turn with its visit; corner output belongs to the step's holder or a turn triggered by its handoff, so another agent's separate conversation supplies neither live nor final output. An optional receipt supplements this result and never replaces it. Do not repeat your final reply as a receipt.

Older saved revisions remain readable and executable. Missing summaries show nothing, missing `does` uses the existing step name, and missing captured output shows nothing. Revising an older workflow requires adding the human metadata; existing runs retain their pinned revision. Past final replies are not backfilled.
