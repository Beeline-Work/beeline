# Beeline feedback loop

Agents and people report problems with Beeline itself into one server-side
store (`feedback_items`, `apps/server/src/feedback.ts`). An agent in an
"Issues triage" corner runs a scheduled sweep: it files redacted issues in the
public repository, attaches reports to existing issues, or dismisses them, and
opens fix corners in the parent Room. When an issue closes as completed, every
reporter hears about the fix in their System DM.

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
    quoted line is not a report.
  - Use the **Report issue** message action, with an optional note.

  Each message can be reported once. A reported message shows a **Reported**
  marker to everyone in the Room.
- Secret-shaped values are refused at write on both paths. Items store message
  ids only; evidence text is read live when triaged.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BEELINE_FEEDBACK_REPOSITORY` | `Beeline-Work/beeline` | The repository issues are filed in and whose `issues` webhook resolves items. The Beeline GitHub App must be installed on it (it already requests `issues: write` and subscribes to `issues`). |

Collection works without it. Without the GitHub App on the repository, the
filing tools return a clear error and items stay `new`.

There is no agent allowlist. Triage access comes from the corner the agent is
working in (below).

## Setting up the triage corner

1. In the Room where fixes should happen, open a **no-code** corner named
   "Issues triage". A no-code corner never opens a pull request, so no merge
   archives it; it stays open until someone closes it.
2. As a Room admin (Workspace owner or admin), open the corner's **…** menu and
   turn on **Feedback triage**. The setting is stored on the corner and is off
   by default. Other members do not see the switch, and the server refuses
   their changes.
3. Add the triage agent to the corner.
4. Ask it to create the sweep schedule in the corner with `create_schedule`,
   every few days (for example every 3 days), using the default prompt below.
   The schedule runs in the corner and wakes that agent there.
5. For each issue worth fixing, the triage agent calls `open_corner` from the
   triage corner. The new corner opens as a **sibling** in the parent Room,
   never inside the triage corner, and its brief carries the issue number. The
   agent assigns it by tagging the agent that should do the work.

Only an agent that is a member of a corner with Feedback triage on, during its
own turn in that corner, can use the triage tools. Every other call gets an
authorization error. Turning the setting off stops the next call.

## Triage tools (Feedback triage corners only)

| Tool | Effect |
| --- | --- |
| `list_feedback` | New items: human reports first, then by cluster size (agent reports with the same category and normalized summary). |
| `get_feedback` | Items with their evidence messages, read under server authority even if the reporter has left the Room. |
| `list_feedback_issues` | Open `beeline-feedback` issues in the configured repository. |
| `file_feedback_issue` | One new issue for new items. The server adds the labels `beeline-feedback` and the category, plus the footer `Beeline feedback: <evidence id> · <n> reports (<h> human, <a> agent)`. The items become `filed`. |
| `attach_feedback_to_issue` | Links new items to an open feedback issue and updates the one server-maintained report-count comment. The items become `attached`. |
| `dismiss_feedback` | Marks new items `dismissed` with the reason. |

If GitHub refuses a write, the items stay `new` and the tool returns GitHub's
reason.

### Redaction

The repository is public. Every title and body is checked before it is
written, and a failing write names its rule; nothing is rewritten:

| Rule | Refuses |
| --- | --- |
| `title-length`, `body-length` | A title over 120 characters, or an issue body over 4000 counting the server footer. |
| `evidence-quote` | Any 40+ character run copied verbatim from the linked evidence or a human note. |
| `email` | An email address. |
| `secret` | A secret-shaped value. |
| `person-name` | A human's handle or display name from the linked Rooms. |
| `room-name` | A linked Room's name. |

## Close the loop

`issues` deliveries for the configured repository are handled whatever any
Room's GitHub events setting is:

- **Closed as `completed`**: items become `resolved`. Each human reporter, and
  the owner of each reporting agent, gets exactly one System DM:
  `Fixed: <title> (#N) <url>`.
- **Closed as `not_planned`**: items become `closed`, with no DM.
- **Reopened**: items return to `filed`.

Redeliveries change nothing and send nothing twice. A reporter whose account
is gone gets no DM.

## Sweep schedule

Cadence comes from an ordinary agent schedule created inside the triage
corner, every few days. Default prompt:

> Run the Beeline feedback sweep. Call `list_feedback`, then `get_feedback` on
> the items you will act on, and `list_feedback_issues` to see what is already
> filed. For each cluster: if an open issue already covers it, use
> `attach_feedback_to_issue`; if it is a real, actionable Beeline problem, use
> `file_feedback_issue` with a short title and a body in your own words (what
> happens, where, and what would fix it), with the matching category label; if
> it is noise, working as intended, or not about Beeline, use
> `dismiss_feedback` with a one-line reason. Never quote evidence, and never
> name people, Rooms, or emails: the repository is public. When a write is
> refused, rewrite it to satisfy the named rule. For each newly filed issue
> worth fixing now, call `open_corner` with a brief that names the issue
> number, then tag the agent best suited to it in that corner. End with one
> line: how many items you filed, attached, and dismissed, and which corners
> you opened.

Issues people file by hand outside this flow are not triaged. The server never
opens corners from feedback issues on its own; only the triage agent does.
