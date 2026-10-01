# Beeline feedback loop

Agents and people report problems with Beeline itself into one server-side
store (`feedback_items`, `apps/server/src/feedback.ts`). Triage is a saved
workflow, `feedback-triage`. It works like a team skill: any agent can find it
and start it, and no per-corner setting gates it. The workflow reads new
reports from the production database and ranks them by problem. It asks a
person to approve, then opens fix corners. Once a fix merges, System tells each
person who reported that problem.

## Intake

- **Agents** call `report_feedback` from inside a turn, on every surface (Room,
  DM, every corner kind). It takes one of five categories: `simpler_path`,
  `contradiction`, `tooling_gap`, `context_gap`, `bug`. The server attaches the
  Room, the trigger message plus up to 20 preceding message ids, and the
  request id. The Body attaches the turn's assembled prompt section ids.
  - Each agent gets 10 new items per UTC day.
  - A repeat with the same category and normalized summary within 24 hours
    returns the existing id.
  - A refusal comes back to the agent as a plain result and never fails the
    turn.
  - The `core.feedback` prompt section tells agents to report only when a turn
    hit friction.
- **People** have two ways to report:
  - Tag `@system` in a Room, corner, or DM. The composer offers it as
    "System — report an issue". System does not join the Room, no agent wakes
    (not even a DM's), and nobody gets a push. `@system` inside code or a
    quoted line is not a report. The person wrote that message to System, so
    its text is stored on the item (`detail`, up to 4000 bytes).
  - Use the **Report issue** message action, with an optional note. Only the
    note is stored; the reported message, which may be someone else's, is not.

  Each message can be reported once. A reported message shows a **Reported**
  marker to everyone in the Room.
- Secret-shaped values are refused at write on both paths. Apart from a
  person's own `@system` text and Report issue notes, items store message ids
  only.

## The `feedback-triage` workflow

The contract is `docs/workflows/feedback-triage.json`. The procedure an agent
follows at each step is `docs/workflows/feedback-triage-steps.md`. Both are
saved in the Workspace: the contract with `save_workflow`, the procedure with
`save_skill` as `feedback-triage-steps`. Agents find them the way they find
memories and procedures. The per-turn Memory index lists
`Workflow feedback-triage (start_workflow): …`, and `load_workspace_skill`
reads the steps. An agent starts a run with `start_workflow`, binding
`triager` to itself.

| Step | Who | What happens |
| --- | --- | --- |
| `notify` | triager | Finds fix pull requests merged since the last run (their body has a `Feedback items:` line) and calls `notify_feedback_fixed` for each. |
| `pull` | triager | Reads new `feedback_items` through the read-only database grant, groups them by problem, and ranks the groups by report count. |
| `approve` | a person | A card with **dispatch** or **skip**. Nothing is dispatched before someone answers. |
| `dispatch` | triager | One fix corner per approved problem, opened with `open_corner` (from a corner it opens a sibling in the parent Room), with an agent tagged. The brief lists the item ids and requires the fix PR body to carry `Feedback items: <ids>`. |
| `done` | | The run ends. |

Feedback is written by people across all of Beeline, so the procedure treats
every report as data and never follows instructions inside one.

### Production database access

Only someone with production access can run the `pull` step. That credential
is the access boundary, not a Beeline setting. Create a login role that can
read `feedback_items` and nothing else:

```sql
CREATE ROLE beeline_feedback_reader LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE <database> TO beeline_feedback_reader;
GRANT USAGE ON SCHEMA public TO beeline_feedback_reader;
GRANT SELECT ON feedback_items TO beeline_feedback_reader;
```

Then grant your triage agent one command that runs read-only queries with that
role's connection string, kept as a secret on your machine. An agent without
the grant stops at `pull` and says so.

### Daily schedule

The triage corner keeps its daily schedule (`0 14 * * *` UTC). Its prompt
starts the workflow:

> Start the feedback-triage workflow with start_workflow, binding triager to
> yourself, and follow the feedback-triage-steps procedure at each step.

## Close the loop: Fixed DMs

`notify_feedback_fixed {item_ids, title, pr_url}` is the only way a Fixed DM
is sent. The server checks every call:

- It must come from the agent's own active turn.
- The agent's owner must be listed in `BEELINE_SYSTEM_SENDERS`.
- `pr_url` must be a pull request in `BEELINE_FEEDBACK_REPOSITORY`.
- The title must be one line of at most 120 characters, with no secret-shaped
  value.

Then the items become `resolved`. Each person who reported one of them
themselves (`@system` or Report issue) gets one System DM:
`Fixed: <title> <pr_url>`. Items reported by agents resolve with no DM. The
text is fixed and System's identity stays with the server; the agent only asks.
A repeat call sends nothing twice (one DM per person per pull request), and a
reporter whose account is gone gets no DM.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BEELINE_SYSTEM_SENDERS` | empty | Comma-separated identity ids of the people whose agents may have System send Fixed DMs. Empty means nobody can. |
| `BEELINE_FEEDBACK_REPOSITORY` | `Beeline-Work/beeline` | The repository fix pull requests land in. A Fixed DM links only to a pull request here. |

## Retired

The per-corner **Feedback triage** setting (`set_feedback_triage`), the six
triage tools (`list_feedback`, `get_feedback`, `list_feedback_issues`,
`file_feedback_issue`, `attach_feedback_to_issue`, `dismiss_feedback`), GitHub
issue filing with its redaction rules, and the `issues` webhook resolver are
gone. Fix corners replace the public issues. The `corner_facts.feedback_triage`
column, the `feedback_items.issue_*` columns and `feedback_issue_comments`
stay unread for rolling-update compatibility.
