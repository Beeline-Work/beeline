# @beeline/body — the Buzzy agent body

The operator-run service that gives the coding agent its computer, enforces the
**read-only → edit tool boundary**, and makes the session **multi-user-visible**
by projecting agent activity into the relay channel.

## Architecture

```
┌──────────────────────── Body machine ────────────────────────┐
│ Thin daemon core (one paired agent identity)                  │
│   ├── one persistent relay socket + deterministic routing    │
│   ├── durable WorkCalendar heap + one next-due timer         │
│   ├── Room A Body ──► killable Room/corner ACP processes     │
│   ├── Room B Body ──► killable Room/corner ACP processes     │
│   └── bounded scheduler + durable per-channel inbox          │
│                │                                             │
│                ├── read mode MCP ──► buzz-readonly-mcp       │
│                ├── edit mode MCP ──► buzz-dev-mcp            │
│                ├── opted-in Squire ─► host credential broker │
│                └── batched session/update ──► relay          │
└──────────────────────────────────────────────────────────────┘
```

- **TLC (read-only):** ACP session with Beeline's fixed
  `buzz-readonly-mcp` inspection surface mounted. It can list and read files,
  perform bounded literal search, and inspect local commit history/diffs. It
  exposes no shell, raw git arguments, filesystem mutation, package install, or
  server process. The agent converses normally. Pure analysis, explanation,
  summary, and research requests are locked to a Room answer and cannot become
  an ALLOW prompt. For non-research work, codex-acp and claude-agent-acp agents
  use the mounted `open_corner` agent tool. An explicit human command to open a
  corner is the only message that creates one without the tool path. A
  creator-only Codex or Claude agent may also mount separately selected Trusty
  Squire capabilities; their side effects require exact P1 factory permission
  and do not widen the filesystem boundary.
- **Subchannel (edit):** ACP session with `buzz-dev-mcp` mounted, `cwd` set to
  a git worktree on a feature branch. Agent has full write access **only within
  the worktree**. An explicit open-a-corner command, a human member's ALLOW
  response, or a host-owned exercise of a captain-signed `mission.control`
  grant creates this session. ALLOW replays the concrete request; DENY leaves
  the Room read-only.
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

4. **`bubblewrap` (optional, recommended; required for Trusty Squire)** — `bwrap` on PATH lets the daemon
   confine every ACP harness child to a read-only filesystem plus the paths that
   session legitimately owns. Without it the daemon logs one advisory line and
   spawns unwrapped; see **Key design decisions** below.

### Ubuntu AppArmor and bubblewrap

Ubuntu hosts with `kernel.apparmor_restrict_unprivileged_userns=1` require an
AppArmor profile before an unprivileged daemon can use bubblewrap. Keep that
system-wide protection enabled. Install a profile for the bubblewrap executable
instead, then prove the real namespace operation and restart each affected
agent:

```bash
sudo install -m 0644 /dev/stdin /etc/apparmor.d/beeline-bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile beeline-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/beeline-bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/beeline-bwrap
bwrap --unshare-pid --ro-bind / / --dev /dev --proc /proc /bin/true
beeline start --agent <agent-pubkey>
```

The attachment applies to `/usr/bin/bwrap`, so every invocation of that exact
binary can create a user namespace. On a shared host, prefer a dedicated
credential-less daemon account or a site-owned narrower profile. Do not work
around the failure by setting `kernel.apparmor_restrict_unprivileged_userns=0`:
that disables the protection for the whole host. A daemon that detects local
Trusty Squire state still fails closed until the bubblewrap self-test passes.

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
| `BUZZ_AGENT_KEY`                    | No       | —                       | Legacy provision/start override; `beeline pair` ignores it and always mints a fresh identity, unless `--use-env-key` opts into reusing it                                                                                                            |
| `BUZZY_BODY_AUTO_APPROVE`           | No       | `1`                     | Auto-approve permissions inside edit corners only                                                                                                                                                                                                    |
| `BUZZY_BODY_SANDBOX`                | No       | `bwrap`                 | `off` disables the bubblewrap OS sandbox for ACP children (overrides `runtime.json`'s `sandbox`)                                                                                                                                                     |

For a remote-backed Room, origin is truth and the checkout under the supervisor
repository cache is disposable. The daemon fetches that remote at Room join,
corner open, and remote-state observation. The checkout used during pairing is history only; it is
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

# Optional per-agent skill share. The named directory must live at
# ~/.agents/skills/review-pr; no other personal skills are inherited.
beeline pair BUZZ-XXXX-XXXX --agent codex --share-skill review-pr

# Optional machine-local credentials. Each profile is a separate opt-in and
# requires creator-only access. Pairing runs Trusty Squire's connect check while
# you are present, opening Google/GitHub in your browser only when the local
# vault or provider link is missing or stale. Codex and Claude are supported.
beeline pair BUZZ-XXXX-XXXX --agent codex --access creator \
  --mcp squire-credential-use
beeline pair BUZZ-XXXX-XXXX --agent claude --access creator \
  --mcp squire-app-access

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

# Interactive pairing reads the selected harness's live model and effort
# catalog and offers only those typed choices. In scripts, the same live
# validation applies to explicit values before runtime.json is written.
beeline pair BUZZ-XXXX-XXXX --agent codex \
  --model <catalog-model-id> --effort <catalog-effort-level>

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
# authorized edits use corners, and GitHub branch death archives them
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

Model and effort values are configuration, not free-form labels. Interactive
pairing searches the exact catalog reported by the selected ACP harness;
`--model` and `--effort` must name entries in that same live catalog. Pairing
stops before persistence when an identifier is unknown or the provider refuses
an advertised-but-retired entry, and preserves useful replacement guidance from
the harness when it is available.

For Grok, use the interactive picker rather than guessing an effort string. It
loads the model catalog first, then offers only the selected model's supported
reasoning efforts. Grok applies model changes through ACP, but effort is a
launch option: a warm session keeps its existing effort, and the next cold
activation re-reads the saved human selection before starting Grok. Switching
to a model whose effort catalog has not yet been observed clears the old effort
selection, preventing a model-specific effort from leaking into the new model.

Every daemon restart revalidates the persisted `runtime.json` selection against
the current live catalog before opening any ordinary ACP turn. A confirmed
unknown or retired value produces `Model unavailable · <selected-id>`. A
harness startup, authentication, or catalog-read failure instead produces
`Model validation unavailable · <selected-id>`; Beeline does not claim the
model was retired when it could not complete validation. In either case the
agent remains connected to its Rooms, reports offline, and posts a Room line
with safe recovery guidance.

For a confirmed unavailable value, open the agent settings in each affected
Room, choose a value from the refreshed catalog, then restart the agent. During
every restart, Beeline live-validates each Room's persisted human-authored
override before publishing that Room's first presence. A valid override clears
only that Room's copied startup block and becomes its effective selection; a
failed override reports that Room offline even when the daemon-wide default is
valid. Sibling Rooms without their own valid override stay blocked, and the
stale local `runtime.json` default is not silently rewritten. For a validation
outage, restore the selected harness, its authentication, and catalog access
before restarting. Beeline never substitutes another model or rewrites Room
history.

Trusty Squire keeps provider credentials in a Body-owned, machine-local store;
Beeline does not upload or centrally custody them, and the daemon never performs
the browser connection ceremony. `squire-credential-use` exposes credential
inventory plus exact, one-call `use_credential`. `squire-app-access` separately
exposes bounded `grant_app_access`, inventory, and `revoke_app_access`; every
grant must include `rate_limit_per_hour` and remains independently revocable.
Each credential use, grant, or revocation requires a fresh, human-owner-signed
P1 `operation.execute` permission for the exact arguments. Ordinary corner
auto-approval and selecting one Squire profile never authorize the other.
Pass both profile names as a comma-separated `--mcp` value only when the agent
needs both capabilities.

For an existing repository Room, pairing joins the agent as a plain member.
Each edit corner receives an exact-repository GitHub App token and ordinary
`git`/`gh` tooling. The agent pushes its feature branch and opens a pull request;
it merges only on an explicit human instruction. The daemon observes the branch
and PR mechanically, posts the PR fact, reports red checks, and treats branch
death as completion. The machine identities, known Room bindings, repo roots,
and daemon state live under
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
into a repository and cannot grant permissions or authorize GitHub operations. The remaining
explicit `serve`/`open` commands are internal diagnostic compatibility surfaces,
not part of the user pairing workflow.

### Factory permissions (P1)

Factory side effects use signed, versioned Room events; model prose is never
authority. The shared scope registry assigns the required human role, executor,
grant limits, and tier for each supported action. Tier 1 grants are standing,
scoped envelopes with expiry, use, rate, monetary/token budget, revocation, and
execution accounting. The deliberately narrow irreversible
`operation.execute` scope is Tier 2 and requires a fresh per-action decision.
Executors re-read membership, role, revocation, and usage immediately before
publishing a `started` receipt. Concurrent decisions fold deterministically and
only the first valid decision counts; replayed or exhausted actions fail closed.

`mission.control` is a Tier 1 captain-signed boundary in that same ledger, not a
second grant system. It names one chief-of-staff controller, Workspace and Room,
exact repository and target ref, permitted corner and schedule operations,
exact target agents, and non-overlapping per-target and per-schedule budget slices.
Every schedule revision digest, firing, target activation, and mission-corner
open/continuation/close is
attenuated from that grant, charged to the existing ledger, and fresh-checked
for current membership, role, expiry, revocation, usage, and budget. The chief
of staff may supply a new exact schedule revision digest within its static
allocation without asking the captain to re-sign the whole mission.

Once revocation is durably recorded, no new firing, turn, or child exercise is
admitted. Anything already admitted before that moment runs to completion; the
current daemon has no revocation chase or cancellation machinery for active
mission work.

### Daemon work calendar (P2)

Each agent daemon owns one durable `WorkCalendar` min-heap and one next-due
timer. Signed kind:30078 schedule records describe expiring, budgeted recurring
turns. Cron and daily cadences require an IANA timezone; intervals use an
explicit anchor. Across daylight-saving transitions, a nonexistent local time
runs at the next valid instant, while a repeated local time runs once at its
first occurrence. Its small atomic local state stores only the pinned principal,
last-executed occurrence, budget/run counters, and consecutive-failure pause;
kind:9 lifecycle receipts are best-effort observability and are never replayed
as execution state. A crash after a turn but before the timestamp write may run
that occurrence again. Every occurrence rechecks the current canonical
revision, author/principal role, Room/Workspace membership, agent access policy,
artifact revisions, expiry, budgets, and any P1 `schedule.change` grant,
including one final fresh check after the background turn wins its process
slot. Catch-up either skips missed work or runs only the latest missed
occurrence. A terminal authority or artifact lapse is durably paused before its
actionable card; restored authority alone does not resume it. Resumption requires
a newer active revision authored by a currently authorized human admin.

Calendar admission is deliberately separate from process capacity. A due item
enters the ordinary Room dispatcher with `trigger='schedule'` and background
priority, and `SessionScheduler` remains the final per-Room/Workspace queue so a
live human turn wins. The schedule itself is the human-authorized mandate for
each occurrence, including send, publish, spend, connector, and attachment
actions; there is no per-action permission request inside a scheduled turn.
Model-emitted control prose remains inert so one
schedule cannot amplify itself into additional recurring or repository work.

Mission schedules execute only on their owning target daemon. Cross-agent
schedule dispatch fails closed; agent-to-agent work starts from a structured
signed mention in a corner instead.

An explicit mission schedule revision chooses `script` or `model`. Script
schedules are hash-bound to their exact creator-authored bytes, run no model by
default, and have a one-minute minimum cadence; model schedules have a
15-minute minimum and receive no native shell or repository-write authority in
the Room. The script path requires bubblewrap and fails closed on a missing
sandbox or hash mismatch. It mounts the host read-only, makes only the canonical
mission repository writable, supplies quota-bounded git-blocked scratch and a
minimal environment, masks credentials, inherits the same network access as a
corner, and bounds the process group, deadline, and output. Its only model wake
is one strict JSON completion line naming the granted target and a safe pointer
inside the same repository. A failed run becomes one durable system line rather
than a chat turn, and repeated failures pause the schedule after the configured
bound (at most three for mission scripts).

### Repository event consumer

GitHub activity is owned by the relay host's single materializer process, not
by any paired agent. The production `beeline-github.env` must provide
`BEELINE_GITHUB_APP_ID` plus `BEELINE_GITHUB_APP_PRIVATE_KEY` (a PEM encoded
with literal `\n` separators is accepted). Optional
`BEELINE_GITHUB_API_BASE_URL` and `BEELINE_GITHUB_EVENTS_REQUEST_TIMEOUT_MS`
exist for GitHub Enterprise and testing. Agent units do not receive these
credentials. The consumer's dedicated non-agent Nostr identity remains under
`~/.local/state/beeline/events/` and its former JSON delivery reservations are
imported into the materializer's Postgres store.
On discovery, the Room daemon enrolls that service key as a normal member before
the first configuration read or card; repository cards are authored only by
the service key. A Room without a current authorized member fails visibly and
retries instead of advancing its GitHub cursor silently.

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
degraded card per failure episode. Materializer logs include each repository's
last successful poll. Durable signed pending cards make restart retries
relay-idempotent.

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
  human's prose. Trusty Squire is the only explicit exception to the fixed Room
  inventory: its separately selected metadata tools remain read-only, while
  each credential or egress side effect is brokered only after an exact P1
  factory permission.
  Information-only turns reject any model-requested mutation without projecting
  ALLOW. DMs are permanently read-only and cannot request or open a corner. A
  repo-less normal Room may request a corner only by naming an exact
  `owner/repo`; the signed human prompt displays and binds that target, and
  clone/access failures leave the Room read-only. Agent completion
  pushes its feature branch and opens a pull request with ordinary `git` and
  `gh`. A merge requires an explicit human instruction; GitHub branch death is
  the daemon's completion signal.
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
  once at daemon start and normally **fails open**: a missing or unusable `bwrap`
  logs one advisory line and spawns unwrapped, exactly as before. A runtime with
  Trusty Squire state or capabilities instead fails closed because its local
  vault and IPC paths must be masked from the agent. Set `sandbox: "off"` in
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
