# Free-agent time-limit continuation

Reproduction `FREE-CONTINUE-1` follows a request through a stopped turn, a
"continue" message, another stop, and a final continuation. The original hard
stop discarded the partial reply, destroyed the conversation and wrote a
successful receipt. The replacement saves a private checkpoint before destroying
the process, retains partial prose, records `failed` / `free-agent-time-limit`,
and offers a smaller first step after another limit. A different request or a
successful continuation clears the checkpoint. Checkpoints include the original
request, bounded partial prose, and recent tool inputs/results with common secret
fields redacted; unconfirmed tools are explicitly unfinished.

## Production finding

The reported task was smoothing a weapon mesh for a game, not changing an avatar.
Read-only production turn rows confirm three attempts on October 26, 2026,
starting at 11:14, 14:25 and 14:51 UTC. Each lasted about fifteen minutes and was
recorded as complete, without a failure reason or tool count. The agent's stored
model selection was `beeline/deepseek/deepseek-v4.1-flash`, using Pi. This is the
stored selection observed during investigation, not an independent historical
provider-generation receipt.

Historical logs remained available in Fly's Grafana dashboard, despite the
initial Fly log API request returning unauthorized. The Machines API separately
confirmed a stopped machine with one shared CPU and two GiB of memory. No
production machine was started, and no production rows were changed.

The helper's historical summaries show:

| Attempt | Activation | Before first visible model text | Later model stream | Observed tool work | Calls |
| --- | --- | --- | --- | --- | --- |
| First | 0.249 s | 47.21 s | 855.18 s | 490.80 s | 11 |
| Second | 36.56 s | 473.29 s | 391.59 s | 186.28 s | 16 |
| Third | 30.08 s | 868.63 s | Not recorded | 582.28 s | 17 |

Tool work overlaps model time; these columns must not be added. The summaries
prove substantial time in tools, especially in the first and third attempts.
Usage events also show long gaps between completed model calls. Those gaps alone
cannot identify a particular shell command or distinguish every tool wait from
provider latency. The available summaries do not name the commands. Mesh
generation or headless game-engine work is plausible, not demonstrated. Exact
commands require the persisted Pi journal on the stopped machine, which was not
started for this investigation.

The second and third attempts were cold sessions. Throwing away their work after
each limit explains why repeated continuation could repeat the same work. The
smallest corrective action is to save a checkpoint and bound each shell command,
while retaining the existing whole-turn limit and process teardown.

One model-usage event immediately after the first stop recorded zero tokens and
USD 2.10057: the proxy retained a worst-case reservation after interruption. The
proxy now refunds an interrupted reply with no usage and settles reported usage
at its actual cost when available.

## Command limit

Free Pi shell calls receive the smaller of five minutes, a shorter caller timeout,
and the remaining turn budget minus the existing delivery reserve. Five minutes
allows substantial mesh work while leaving most of a fresh fifteen-minute turn
for inspection, a smaller command and delivery. Pi's shell executor kills the
process tree and includes partial output in the timeout error. Paid agents and
the whole-turn limit are unchanged.

## Proof routes

- `apps/body/src/free-agent-continuation.integration.test.ts` runs real ACP stdio
  subprocesses through Room and corner loops, verifying one visible reply per
  turn, preserved partial text, checkpoint delivery on both continuations,
  smaller-step wording and failed receipts. With `BEELINE_PROOF_BUILT=1`, it uses
  the built helper modules. Harness answers and the daemon boundary are fixtures;
  it does not run a person's model or production session.
- `apps/server/src/turn-replay.integration.test.ts` also runs Room and corner
  loops against the daemon and phone services and an isolated PGlite database.
  The time-limit variants verify the visible reply, a single message and the
  persisted failed turn. `BEELINE_REPLAY_BUILT_PROOF=1` selects built services.
- `apps/body/src/free-agent-continuation.test.ts` verifies recovery after helper
  replacement, tagged continuation, secret-field redaction, private file mode,
  and reset for a different request.
- `apps/body/src/pi-turn-budget.test.ts` exercises the real Pi shell executor:
  partial output survives, the long command stops, and its later output is absent.
- `apps/server/src/free-agent-model-proxy.test.ts` exercises HTTP streaming and
  real reservation settlement for interrupted replies with and without usage.
- `docs/prompts/cases/free-agent-continue-keeps-work.json` is the redacted model
  behavior case. Prompt replay results must distinguish unscored fixtures,
  budget limits, and baseline failures from measured regressions.

A deliberate production hard stop would disrupt a person's active task and is
not used as a proof. The isolated helper/service paths above are the stand-in
for that real target under `FREE-CONTINUE-1`.
