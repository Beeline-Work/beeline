# Workflows

A workflow is a saved contract that passes work between named roles in a Room. Each step names who acts, what they must hand over, and where each outcome goes next. Runs live in the Room transcript: every step is posted as a handoff card.

A workflow does not run on a timer. It moves only when a bound agent calls `handoff` or a human answers a gate. For work that repeats (a check every few minutes, a daily start), schedule the workflow owner with `create_schedule` and `workflowName`, and have that scheduled turn call `start_workflow`. Other agents join an existing run through `handoff` with its full run ID.

## Tools

| Tool | What it does |
| --- | --- |
| `save_workflow` | Validates a contract and saves it Workspace-wide, versioned by `name`. Saving the same name again makes a new version. |
| `start_workflow` | Starts a run of a saved workflow in this Room. You bind every role, and it returns a `runId`. |
| `handoff` | Moves a run you hold to its next state. You give an `outcome` and the `contents` the state requires. |
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
    "draft": {
      "role": "writer",
      "hint": "the draft note",
      "requires": ["text"],
      "on": { "submitted": "review", "timeout": "stuck" },
      "timeoutSeconds": 3600
    },
    "review": {
      "role": "reviewer",
      "requires": ["verdict", "notes"],
      "on": { "approved": "sign_off", "changes_requested": "draft" },
      "loop": { "onEdge": "changes_requested", "cap": 3, "onExceeded": "stuck" }
    },
    "sign_off": {
      "kind": "gate",
      "role": "approver",
      "requires": ["decision"],
      "on": { "publish": "done", "reject": "failed" }
    },
    "stuck": {
      "kind": "gate",
      "role": "approver",
      "requires": ["decision"],
      "on": { "retry": "draft", "abandon": "failed" }
    },
    "done": { "kind": "terminal", "status": "done" },
    "failed": { "kind": "terminal", "status": "failed" }
  }
}
```

### Top level

| Key | Rule |
| --- | --- |
| `version` | Always `1`. |
| `name` | Lowercase words joined by hyphens (`a-z`, `0-9`, `-`). No underscores. At most 64 characters. |
| `description` | 1-60 characters. |
| `summary` | Optional plaintext on one line, at most 140 characters. Shown above the state rail; absent means nothing is shown. |
| `roles` | 1-16 unique role names. Lowercase letters, digits, `_` or `-`, starting with a letter. |
| `start` | The state a run begins in. It must not be a terminal. |
| `handoffs` | 2-64 states, keyed by state name. State names follow the role-name rule. |

Unknown top-level keys are rejected.

### State kinds

Every state may have an optional free-text `hint` describing the outcome or artifact to attach when leaving it. The dispatched agent sees this hint in its command before calling `handoff`. A hint does not require a receipt.

**Handoff** (no `kind`): a role acts and reports an outcome.

| Key | Rule |
| --- | --- |
| `role` | One of `roles`. Required. |
| `requires` | Field names that `handoff` must include in `contents`, up to 32. Letters, digits and `_`. Use `[]` for none. |
| `on` | Outcome to next state, 1-16 outcomes. Each target must be a declared state. |
| `loop` | Optional cap on one outcome: `{ "onEdge": <outcome>, "cap": 1-100, "onExceeded": <state> }`. `onExceeded` must differ from where `onEdge` normally goes. |
| `timeoutSeconds` | Optional, 60 to 2592000. Needs a `timeout` outcome in `on`. When it elapses, the bound agent is reminded to call `handoff` with outcome `timeout`. |

**Gate** (`"kind": "gate"`): a human decides. It allows only `kind`, `role`, `requires`, `on` and optional `hint`, and needs 2-4 outcomes of at most 32 characters each. The run posts a choice card with one option per outcome. When a human answers, the role's agent is woken and calls `handoff` with the chosen outcome.

**Terminal** (`"kind": "terminal"`): the run ends. It allows only `kind`, `status` and optional `hint`, where status is `done`, `failed` or `abandoned`.

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

Each saved definition has one run owner, separate from its role bindings. New definitions default to the saving agent; later saves preserve that owner and the original creator. Only the owner agent can start runs or create/update schedules targeting the workflow. Reads and schedule lists include the owner and active run IDs; a refused start names both. A schedule targeting a workflow follows its current owner, including after a transfer.

Existing definitions migrate from recorded agent creator, then the creator of the latest workflow schedule. If neither is known, the workflow page shows “no owner, starts blocked” until an authorized human assigns one. A human Room/Workspace admin may start or edit schedules; the start card or schedule edit records that human. Scheduled starts record the owner and the schedule origin.

The creator agent's human owner and human Room/Workspace admins can use **Change owner** on the workflow page or `transferWorkflowOwner` (`roomId`, `name`, `ownerId`). Agents cannot transfer ownership. Each transfer records the actor, old/new owners and time in `workflow_owner_transfers`. Changing owner leaves existing runs and their role bindings intact. The Room menu’s **Workflows** entry lists definitions even before their first run. The run page also links to **All runs**, where starter attribution and full run IDs are visible, including the no-run/no-owner state.

1. **Save.** Call `save_workflow` with `{ "contract": { ... } }`. It returns `{ "slug", "version" }`. A run already in progress keeps the version it started with.
2. **Start.** Call `start_workflow` with `{ "name", "roleBindings" }`. Bind every role to either:
   - an agent id (64 hex characters) of a current member of this Room,
   - a member's handle (for example `candy`, with or without the `@`), or
   - an ordered list of up to 16 such agents. The role goes to the first healthy agent on the list (online, no failed turn in the last 5 minutes, not out of credit). That agent keeps the role unless its turn fails or goes silent; then the role moves to the next healthy agent on the list.

   The run posts a card whose message id is the `runId` and wakes the agent bound to the start state. If the start state is a gate, it posts the gate's choice card instead.
3. **Hand off.** The agent holding the current state calls `handoff` with `{ "runId", "outcome", "contents" }`. The outcome must be one the state declares. `contents` must be an object, at most 16 KB, containing every `requires` field. The next state's agent is woken automatically, so no @mention is needed.
4. **Gates.** When a run reaches a gate, a choice card is posted for a human. After they answer, the gate role's agent calls `handoff` with the chosen outcome.
5. **No healthy agent.** If nobody on a list-bound role's list is healthy, the run says so in the Room and waits. A human can ask an agent to call `assign_workflow_role` with `{ "runId", "role", "agentId" }` to bind any agent in the Room.
6. **End.** The run ends when it reaches a terminal state. `handoff` on an ended run is refused.
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

The run page has one vertical rail, with one circle per declared state. Active states list their exits; finished states show the taken exit and actor. Rows show the title, actor and duration, then the optional receipt line and chips. Expanding a row shows timestamps and exit details. There is no horizontal rail or previous-runs counter.
