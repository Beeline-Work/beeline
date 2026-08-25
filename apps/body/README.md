# @beeline/body — the Buzzy agent body

The operator-run service that gives the coding agent its computer, enforces the
**read-only → edit tool boundary**, and makes the session **multi-user-visible**
by projecting agent activity into the relay channel.

## Architecture

```
┌──────────────────────── Body machine ────────────────────────┐
│ Thin daemon core (one paired agent identity)                  │
│   ├── one persistent relay socket + deterministic routing    │
│   ├── Room A Body ──► killable Room/corner ACP processes     │
│   ├── Room B Body ──► killable Room/corner ACP processes     │
│   └── bounded scheduler + durable per-channel inbox          │
│                │                                             │
│                ├── read mode MCP ──► buzz-readonly-mcp       │
│                ├── edit mode MCP ──► buzz-dev-mcp            │
│                └── batched session/update ──► relay          │
└──────────────────────────────────────────────────────────────┘
```

- **TLC (read-only):** ACP session with only Beeline's fixed
  `buzz-readonly-mcp` inspection surface mounted. It can list and read files,
  perform bounded literal search, and inspect local commit history/diffs. It
  exposes no shell, raw git arguments, filesystem mutation, package install, or
  server process. The agent converses normally. Pure analysis, explanation,
  summary, and research requests are locked to a Room answer and cannot become
  an ALLOW prompt. For non-research work, codex-acp and claude-agent-acp agents
  initiate the edit-corner request by attempting the required mutating tool;
  their real `session/request_permission` becomes a signed Room prompt. pi-acp
  cannot send that protocol request, so only pi-backed Rooms retain the
  stripped `CORNER_REQUEST:` text fallback. An explicit human command to open a
  corner is the only message that creates one without the approval card.
- **Subchannel (edit):** ACP session with `buzz-dev-mcp` mounted, `cwd` set to
  a git worktree on a feature branch. Agent has full write access **only within
  the worktree**. Either an explicit open-a-corner command or a human member's
  ALLOW response creates this session. ALLOW replays the concrete request;
  DENY leaves the Room read-only.
- **Thin daemon core:** one `beeline pair` creates one durable agent
  identity. Humans explicitly invite that existing identity to repository Rooms;
  the core discovers current role projections with bounded three-Room
  concurrency and starts or drains an isolated `Body` for each Room. It never
  runs Git in-process: out-of-turn repository work is a deadline-bound JSON
  worker whose entire process group is killed on timeout.
- **Session isolation and scheduling:** every Room and corner has a stable
  `(agent, channel)` logical session and its own ACP process/history. A shared
  scheduler caps live processes, serializes turns per channel, and idles LRU
  processes without sharing conversation context.
- **Durable delivery:** accepted input, composite cursors, delivery attempts,
  and conversation replay are persisted per channel. Same-corner input steers
  the active run; cancel is an explicit ordered control event.
- **Activity projection:** ACP `session/update` notifications are bridged in
  ordered batches as kind:9 events with `#t=agent-activity`, so **all channel
  members see the agent work live** without exhausting per-key relay quotas.
- **Link-only attachments:** Room messages expose files to ACP as a durable URL,
  filename, MIME type, and byte count; the agent fetches that URL only when the
  task requires it. To send a worktree file back, the agent writes
  `[[buzz-attachment:path]]` in its final response. Body removes the directive,
  uploads the file through the authenticated relay media endpoint, and signs the
  same attachment tags used by mobile. Structured ACP image outputs are detected
  automatically, while their base64 fields are removed from projected activity.
- **Identity boundary:** the operator and agent always have distinct Nostr
  keypairs. The agent signs session activity, control messages, and kind:9007
  subchannel creation. Community-linked TLCs also get a self-signed agent record.

## Prerequisites

1. **Buzz relay** — the local stack or a remote one.

   ```bash
   cd <repo-root> && docker compose -f relay-stack/compose.yml up -d
   ```

2. **Beeline CLI and agent runtimes** — installed together by the hosted installer below.

3. **LLM egress credentials** — set via env or file (see below).

4. **`bubblewrap` (optional, recommended)** — `bwrap` on PATH lets the daemon
   confine every ACP harness child to a read-only filesystem plus the paths that
   session legitimately owns. Without it the daemon logs one advisory line and
   spawns unwrapped; see **Key design decisions** below.

## Configuration (env vars)

| Variable                            | Required | Default                 | Description                                                                                                                                                                                                                                          |
| ----------------------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUZZ_AGENT_BIN`                    | No       | explicit reference only | Reference `buzz-agent` override                                                                                                                                                                                                                      |
| `BUZZ_DEV_MCP_BIN`                  | No       | auto-detect             | Path to `buzz-dev-mcp` binary                                                                                                                                                                                                                        |
| `BUZZ_READONLY_MCP_BIN`             | No       | bundled/auto-detect     | Path to Beeline's inspection-only MCP                                                                                                                                                                                                                |
| `BUZZY_RELAY_HOST`                  | No       | `usebeeline.app`        | Relay HTTP/WS host (`relay.buzzrouter.com` remains an accepted alias)                                                                                                                                                                                |
| `BUZZY_RELAY_SCHEME`                | No       | `https`                 | Relay scheme                                                                                                                                                                                                                                         |
| `BUZZY_BODY_WORKSPACE`              | No       | `./body-workspace`      | Agent workspace root                                                                                                                                                                                                                                 |
| `BUZZY_BODY_LLM_FILE`               | No       | —                       | Path to LLM credentials env file                                                                                                                                                                                                                     |
| `BUZZY_BODY_MAX_SESSIONS`           | No       | dynamic                 | Optional fixed Workspace-wide live ACP process ceiling                                                                                                                                                                                               |
| `BUZZY_BODY_MAX_SESSIONS_PER_ROOM`  | No       | `10`                    | Per-Room live ACP ceiling; invalid values use 10. Higher values add resident-process RAM (typically hundreds of MB each) and can reach provider concurrency limits/HTTP 429 sooner; token spend is unchanged because queued corners do the same work |
| `BUZZY_BODY_MAX_SESSIONS_FLOOR`     | No       | `4`                     | Minimum dynamic Workspace ceiling; actual ceiling is `max(floor, per-room × active Rooms)`                                                                                                                                                           |
| `BUZZY_BODY_SESSION_IDLE_MS`        | No       | `300000`                | Idle time before process suspension                                                                                                                                                                                                                  |
| `BUZZ_BODY_KEY`                     | No       | auto                    | Body operator Nostr nsec/hex                                                                                                                                                                                                                         |
| `BUZZ_AGENT_KEY`                    | No       | —                       | Legacy provision/start override; `beeline pair` ignores it and always mints a fresh identity                                                                                                                                                         |
| `BUZZY_BODY_AUTO_APPROVE`           | No       | `1`                     | Auto-approve permissions inside edit corners only                                                                                                                                                                                                    |
| `BUZZY_BODY_SANDBOX`                | No       | `bwrap`                 | `off` disables the bubblewrap OS sandbox for ACP children (overrides `runtime.json`'s `sandbox`)                                                                                                                                                     |
| `BUZZY_BODY_SYNC_OPERATOR_CHECKOUT` | No       | `0`                     | `1` opts into clean, same-branch, fast-forward-only post-land pairing-checkout sync                                                                                                                                                                  |

For a remote-backed Room, origin is truth and the checkout under the supervisor
repository cache is disposable. The daemon fetches that remote at Room join,
corner open, and land. The checkout used during pairing is history only; it is
never an agent cwd or a recap source. Local-only Rooms explicitly declare their
canonical checkout as truth and never fall back to an operator tree.

### LLM credentials

The body maps `BUZZY_LLM_*` env vars (from the egress helper) onto `OPENAI_COMPAT_*`
for buzz-agent. **Never commit or log these values.**

Example env file (pass via `BUZZY_BODY_LLM_FILE`):

```
BUZZY_LLM_BASE_URL=https://your-endpoint.com/v1
BUZZY_LLM_API_KEY=sk-...
BUZZY_LLM_MODEL=deepseek/deepseek-chat-v3.1
```

## Usage

### CLI

Install the CLI and its agent runtimes without cloning this repository (requires
Node.js 20.11 or newer):

```bash
curl -fsSL https://usebeeline.app/install | sh
```

The installer selects the platform bundle, verifies its checksum, and installs
`beeline`, `buzz-agent`, `buzz-dev-mcp`, and `buzz-readonly-mcp` under `~/.local`. It is safe to run
again and does not modify any existing `buzz` command. Ensure `~/.local/bin` is
on `PATH`; the installer prints the exact export when it is not.

```bash
# Supported user path: pair the agent identity and launch its durable daemon.
# The current directory is never treated as repository intent; Rooms already
# carry their own selected repository binding.
# With no --agent flag, Beeline detects Codex, Claude Code, Goose, Pi, and Grok.
# Installed agents with a missing ACP adapter remain in the numbered menu and
# offer to install it when selected. Non-interactive runs print the exact manual
# install command and never install packages automatically.
beeline pair BUZZ-XXXX-XXXX

# Explicit opt-in only: create or join the Room for this repository at pair time.
beeline pair BUZZ-XXXX-XXXX --repo /path/to/repo

# Piped/non-interactive sessions with several matches must choose explicitly.
beeline pair BUZZ-XXXX-XXXX --agent codex

# New agents default to creator-only access. To delegate intake to an exact
# set of identities, use npub or 64-character hex keys (up to 64 entries).
# The creator is not added implicitly to an allowlist.
beeline pair BUZZ-XXXX-XXXX --agent codex \
  --access allowlist --allow npub1...,0123...cdef

# Use the operator's own funded Codex configuration through the official ACP
# adapter. Install once with:
#   npm install -g @openai/codex @agentclientprotocol/codex-acp
beeline pair BUZZ-XXXX-XXXX --agent codex

# Claude Code requires its ACP adapter:
#   npm install -g @agentclientprotocol/claude-agent-acp
beeline pair BUZZ-XXXX-XXXX --agent claude

# Goose exposes ACP natively as `goose acp`.
beeline pair BUZZ-XXXX-XXXX --agent goose

# Pi uses the registry-listed pi-acp adapter:
#   npm install -g @mariozechner/pi-coding-agent pi-acp
beeline pair BUZZ-XXXX-XXXX --agent pi

# Grok speaks ACP natively over `grok agent stdio`; no adapter binary needed.
#   curl -fsSL https://x.ai/cli/install.sh | bash
beeline pair BUZZ-XXXX-XXXX --agent grok

# Cursor has no native ACP mode. Install the Cursor CLI and the community
# bridge, then drive it through the custom path:
#   curl -fsSL https://cursor.com/install | sh && cursor-agent login
#   npm install -g cursor-acp
beeline pair BUZZ-XXXX-XXXX --agent custom --agent-command 'cursor-acp'

# The bundled reference agent is an explicit fallback for development and
# requires an LLM key/configuration from the operator.
BUZZY_BODY_LLM_FILE=/path/to/local-model.env \
  beeline pair BUZZ-XXXX-XXXX --agent reference

# Any ACP-over-stdio server can be selected explicitly. The command is parsed
# into argv and spawned directly; no shell expansion is performed.
beeline pair BUZZ-XXXX-XXXX --agent custom \
  --agent-command 'my-agent serve --acp'

# Restart a previously-paired agent after a machine/process restart.
beeline start

# Stop and disable one supervised agent.
beeline stop --agent <full-agent-pubkey>

# Explicitly migrate stored runtime(s) without re-pairing. Identities, Rooms,
# and worktrees stay intact; each selected daemon stops and restarts cleanly.
beeline relay set https://usebeeline.app --agent <full-agent-pubkey>
beeline relay set https://usebeeline.app --all

# Inspect today's model calls/tokens, the user event that caused every turn,
# and old-unbounded versus capped session re-prime tokens per daemon restart.
# Adapter-reported usage is exact; fallback estimates are marked with `~`.
beeline spend
beeline spend --day 2026-08-20 --agent <agent-pubkey>
beeline spend --day 2026-08-20 --json

# Provision a read-only agent to a TLC channel
npm run body -- provision <channel-uuid>

# Keep the body attached: addressed chat stays in the read-only Room; human-
# authorized edits use corners, and signed corner approvals land + archive
npm run body -- serve <channel-uuid> <repo-owner-hex> <repo-name>

# Open a subchannel (edit session) under a TLC
npm run body -- open <tlc-uuid> <repo-owner-hex> <repo-name>

# Archive a subchannel
npm run body -- archive <subchannel-uuid>
```

`pair --repo` uses `origin` as the repository identity. HTTPS and SSH clone
forms are normalized and credential material is discarded, so clones of the
same remote in one Workspace converge on one Room. Room creation is a human
action: `pair --repo` JOINS the Room already bound to that repository and
fails with an actionable message when none exists — it never creates one (a
human creates Rooms, and binds repositories to them, from the app). With no
`origin`, explicit `--repo` pairing joins a local-only Room bound to that
repository. A bare `pair` never inspects cwd and creates no repository
binding. A Room has one immutable repository binding; multiple paired agents in
it create parallel feature branches of that repository.

Pairing is Workspace-scoped, not Room-scoped. To serve another repository Room,
open that Room in the mobile app and tap `＋ Agent`; the human-signed membership
write attaches the already-linked identity using the active Workspace ID. No
second CLI pairing occurs. Removing that membership stops new intake, drains
accepted turns, and releases that Room's processes.

For an existing repository Room, pairing ensures the pairing human and the
Room's dedicated merge-worker identity are admins, then joins the agent as a
plain member. The worker discovers every change opened in that Room and lands a
feature tip only after an approval for that corner from a human admin; agent-signed
approvals remain refused. Both pairing and daemon/`serve` startup assert that the
agent cannot push the protected branch and exit fatally on unsafe policy. The
machine identities, known Room bindings, repo roots, and daemon state live under
`<state-root>/beeline/agents/<agent-pubkey>/` with mode `0600`; a compatibility
pointer may remain under a paired repository's git common directory. `pair`
always generates a fresh agent key in machine-local state; it never reads
`BUZZ_AGENT_KEY` or the legacy human `BUZZ_PRIVATE_KEY`. Under systemd the daemon runs in the
foreground and is restarted by the user unit. A restart rediscovers Rooms,
restores corner
worktrees and durable inboxes, replays only the capped recent conversation into
fresh ACP processes, and resumes each unfinished human-commissioned corner at
most once in that daemon process. Recaps, moved-target handling, idle ticks, and
failed turns never start model work on their own; another attempt requires a new
human message. `beeline spend` attributes a restart continuation to the original
human request and groups re-prime counts and before/after token sizes by daemon
process generation.

### Restore a removed agent runtime

A corroborated Workspace removal stops the daemon but never deletes its identity.
The complete runtime directory is moved to
`<state-root>/deleted-runtimes/<agent-pubkey>-<timestamp>/`, and the daemon logs
that exact archive path. The default `<state-root>` is `~/.local/state`; when
`XDG_STATE_HOME` is set, it is that directory instead.

To restore one, first make sure no newly paired runtime exists for the same
pubkey. Move the archived directory back to
`<state-root>/beeline/agents/<agent-pubkey>/`, then run
`beeline start --agent <agent-pubkey>`. Repo-local compatibility pointers are
not required for `--agent`; they remain absent until a later pairing or explicit
maintenance step recreates them.

```bash
mv /path/to/state-root/deleted-runtimes/PUBKEY-TIMESTAMP /path/to/state-root/beeline/agents/PUBKEY
beeline start --agent PUBKEY
```

The coding model always comes from the selected operator-owned coding agent. The
explicit `reference` fallback instead uses the operator's local environment or
`BUZZY_BODY_LLM_FILE`; pairing neither requests nor stores a Beeline LLM key.
Souls are separate, human-signed persona overlays. Their name, personality, and
intent are passed directly into ACP session instructions; they are never written
into a repository and cannot grant permissions or approve merges. The remaining
explicit `serve`/`open` commands are internal diagnostic compatibility surfaces,
not part of the user pairing workflow.

### Factory permissions and delegation (P1)

Factory side effects use signed, versioned Room events; model prose is never
authority. The shared scope registry assigns the required human role, executor,
grant limits, and tier for each supported action. Tier 1 grants are standing,
scoped envelopes with expiry, use, rate, monetary/token budget, revocation, and
execution accounting. The deliberately narrow irreversible
`operation.execute` scope is Tier 2 and requires a fresh per-action decision.
Executors re-read membership, role, revocation, and usage immediately before
publishing a `started` receipt. Concurrent decisions fold deterministically and
only the first valid decision counts; replayed or exhausted actions fail closed.

Agent-to-agent Room work uses signed delegation turns rather than inheriting the
sender's session. Each admitted work item is addressed to one exact agent and
runs as one ordinary read-only Room turn with its own tools, filesystem, and
provider account. Provenance, principal/payer attribution, deadlines, depth,
child count, turn count, reserved-token limits, cycle detection, and durable
receipts bound the graph. Failed work publishes a failed receipt and is not
retried through another model turn. Extending a delegation beyond its original
envelope requires a scoped permission grant.

An agent may propose deterministic invite-only Room creation only through the
bounded `create [an] [outcome] room named "…" with @…` directive. A device-held human
admin grants and executes the request from a durable mobile outbox, using the
request's reserved Room UUID so crashes and concurrent admins reconcile instead
of creating duplicates. This permission-gated factory path is separate from
`beeline pair --repo`, which still only joins an existing repository Room.

### Daemon work calendar (P2)

Each agent daemon owns one durable `WorkCalendar` min-heap and one next-due
timer. Signed kind:30078 schedule records describe expiring, budgeted recurring
model turns. Their replaceable key is
`d=buzz-work-schedule:<workspaceId>:<agentPubkey>:<scheduleId>`; cron and daily
cadences require an IANA timezone, while intervals use an explicit anchor.
Nonexistent local times run at the next valid instant and repeated local times
run once at their first nominal occurrence. Catch-up either skips every missed
turn or runs only the latest one.

Deterministic kind:9 run receipts and a local atomic reservation journal prevent
duplicate activation across restarts. Every occurrence rechecks the current
canonical revision, author and principal roles, Room/Workspace membership,
agent access policy, expiry, run/token budgets, and any P1 `schedule.change`
grant, including one final fresh check after the background turn wins its
process slot.

Calendar admission is deliberately separate from process capacity. A due item
enters the ordinary Room dispatcher with `trigger='schedule'` and background
priority, and `SessionScheduler` remains the final per-Room/Workspace queue so a
live human turn wins. A schedule authorizes only recurring read-only model turns;
it never authorizes sending, publishing attachments, spending, editing, opening
a corner, delegating, or using an irreversible connector. The first attempted
irreversible action emits an exact P1 permission request and performs no side
effect. Model-emitted delegation and text-corner directives remain inert, so one
schedule cannot amplify itself into additional recurring work.

The hard runtime bounds are expiry, maximum runs, per-run and daily token
budgets, and the consecutive-failure pause. Every occurrence revalidates the
pinned principal's current owner/admin role independently of the event author.
Cold recovery accepts that principal only from daemon-signed run history or an
unambiguous signed revision-1 creation record (including the human grant chain
for agent authors); otherwise it refuses the schedule. A principal membership,
owner/admin-role, or drive-authority lapse durably pauses that revision; restored
authority alone cannot restart it, and a newer active revision must be directly
authored by a currently authorized human. The daemon signs a monotonic runtime
checkpoint with cumulative run and daily budget totals, latest settled
occurrence, failure count, pause reason, and receipt cursor. Each refresh
verifies that checkpoint and reads only a bounded receipt tail, so a million-run
schedule has constant-size recovery work; a missing, tampered, regressing, or
truncated checkpoint/tail fails closed.

### Repository event service

GitHub activity is owned by one host-wide service, not by any paired agent:

```bash
mkdir -p ~/.config/beeline
$EDITOR ~/.config/beeline/events.env
beeline events install
```

`events.env` is mode-0600 operator configuration and must provide
`BEELINE_GITHUB_APP_ID` plus `BEELINE_GITHUB_APP_PRIVATE_KEY` (a PEM encoded
with literal `\n` separators is accepted). Optional
`BEELINE_GITHUB_API_BASE_URL` and `BEELINE_GITHUB_EVENTS_REQUEST_TIMEOUT_MS`
exist for GitHub Enterprise and testing. Agent units do not read this file;
the credentials and the service's dedicated non-agent Nostr identity remain
under `~/.config/beeline/` and `~/.local/state/beeline/events/` respectively.
On discovery, each Room's dedicated merge-gate admin enrolls that service key
as a normal member before the first configuration read or card; repository
cards are still authored only by the service key. A legacy Room without a
stored admin fails visibly and retries until an authorized Room identity is
available instead of advancing its GitHub cursor silently.

The service scans durable runtime records, groups Room bindings into one poll
per GitHub repository per Workspace, and fans one compact ambient card to each
bound Room. It includes:

- human pushes, plus bot pushes only when they target a Room's landing branch;
- pull requests opened, reopened, closed, or merged;
- issues opened, reopened, or closed;
- completed workflow/check conclusions; and
- new pull-request review comments.

Other GitHub event types and high-churn actions such as PR synchronize/labeled
events advance the cursor silently. Cards are capped at ten facts, never carry
recipient mention tags, and `@beeline/push-gateway` explicitly refuses
`#t=github-event`, so repository activity is Room content but never a phone
notification. First contact backfills at most 20 raw GitHub events. A legacy
Body cursor seeds at the current GitHub head instead, preventing a migration
replay flood.

Every GitHub request and relay publish is deadline-bounded. Active repositories
poll faster, idle repositories slow to five minutes, and failures back off per
repository without delaying siblings. Three consecutive failures publish one
degraded card per failure episode; systemd `STATUS=` always includes each
repository's last successful poll. Durable signed pending cards make restart
retries relay-idempotent.

### As a library

```typescript
import { Body, loadBodyConfig } from '@beeline/body';
import { newIdentity } from '@beeline/gate';

const config = loadBodyConfig({ workspaceRoot: '/tmp/workspace' });
const body = new Body(config, newIdentity('operator'), newIdentity('coding-agent'));

// Provision read-only agent to a TLC
const session = await body.provision(tlcChannelId);

// Internal/diagnostic direct-open API. The supported Room flow opens this only
// after the agent requests a mutating tool and a human allows it.
const sub = await body.openSubchannel(tlcChannelId, {
  ownerHex: '...',
  repo: 'my-repo',
});

// Archive when done
await body.archiveSubchannel(sub.subchannelId);

await body.dispose();
```

## Testing

```bash
# Hermetic tests (no relay/LLM needed)
npm test

# Live tests (requires relay + LLM credentials)
npm run test:live
```

The live test suite soft-skips when the relay is unreachable or LLM env is
absent. It **never skips when both are present**.

### Env for live tests

Set `BUZZY_BODY_LLM_FILE` to an env file with the LLM credentials:

```
BUZZY_LLM_BASE_URL=...
BUZZY_LLM_API_KEY=...
BUZZY_LLM_MODEL=...
```

or export the `BUZZY_LLM_*` vars (or the `OPENAI_COMPAT_*` vars directly)
into the process environment.

## Key design decisions

- **The boundary IS the MCP mount:** stock buzz-dev-mcp always registers `shell`,
  `str_replace`, etc. There is no env flag to disable write tools. The body
  mounts its own narrow `buzz-readonly-mcp` in Rooms and never mounts
  `buzz-dev-mcp` there. The inspection server uses repository-root-contained
  read APIs and fixed local git commands; it has no shell or mutation tool. A
  Room ALLOW never approves the original tool against the paired checkout; it
  opens an isolated worktree and replays the request in a new edit session.
  Explicit open-a-corner commands bypass that extra prompt by authorizing the
  isolated worktree directly. Permission-capable agents initiate the request;
  Body does not synthesize a permission request from mutation verbs in the
  human's prose.
  Information-only turns reject any model-requested mutation without projecting
  ALLOW. DMs are permanently read-only and cannot request or open a corner. A
  repo-less normal Room may request a corner only by naming an exact
  `owner/repo`; the signed human prompt displays and binds that target, and
  clone/access failures leave the Room read-only. Agent completion
  can publish only the feature ref and `merge-ready`; target landing and archive
  cleanup require an independently verified approval for that corner from a
  device-held human admin.
- **The permission handler is the policy; bubblewrap is the floor.** The Room
  read-only rule and the corner worktree rule are enforced in the ACP permission
  callback (`session-sandbox.ts`), which only binds a harness that actually asks
  — and `pi-acp` never does (see `harness-capabilities.ts`). When `bwrap` is
  installed the daemon additionally spawns every ACP child into a mount
  namespace (`bwrap-sandbox.ts`): the whole filesystem read-only, a private
  `/tmp`, read-write binds for that harness's own state directories, and — for a
  corner only — its worktree plus the git common directory it commits through.
  A Room therefore cannot write any checkout, or anywhere else on the host.
  Harness state is writable in **both** modes on purpose: with it read-only,
  `codex-acp` cannot open a Room session at all and `pi-acp` cannot open one in
  either mode, which is worse than the gap it closes; the harness's own
  bookkeeping is neither the repository nor the operator's tree.
  `harness-sandbox.live.test.ts` holds that line for every installed adapter.
  Network is untouched, since every harness needs its model API. Detection runs
  once at daemon start and **fails open**: a missing or unusable `bwrap` logs one
  advisory line and spawns unwrapped, exactly as before. Set `sandbox: "off"` in
  the agent's `runtime.json` (or `BUZZY_BODY_SANDBOX=off`) on a host where
  bubblewrap misbehaves.
- **Edit-corner permission intent is authority-free:** any current human Room member may
  answer the prompt. The signed response is bound to the agent, permission UUID,
  and original request event; it changes no Room role and grants no merge power.
  Factory permission decisions use the role and custody checks described above;
  this rule applies only to opening an edit corner.
- **Driving buzz-agent directly:** buzz-acp auto-approves permissions and does
  not expose `session/update` to the relay. The body owns the ACP bridge so it
  can enforce the tool boundary and project activity.
- **Subchannel = child channel:** a new UUID channel (kind:9007) with mirrored
  members, backed by a git worktree. The agent identity creates/owns it; the
  subchannel _is_ the PR.
