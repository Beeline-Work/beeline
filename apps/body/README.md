# @beeline/body — the Buzzy agent body

The operator-run service that gives the coding agent its computer, enforces the
**read-only → edit tool boundary**, and makes the session **multi-user-visible**
by projecting agent activity into the relay channel.

## Architecture

```
┌──────────────────────── Body machine ────────────────────────┐
│ Workspace supervisor (one paired agent identity)             │
│   ├── Room A Body ──► isolated Room/corner ACP processes     │
│   ├── Room B Body ──► isolated Room/corner ACP processes     │
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
  an ALLOW prompt. For non-research work, the first actual mutating-tool request
  becomes a signed Room prompt. An explicit human command to open a corner is
  the only message that creates a corner directly.
- **Subchannel (edit):** ACP session with `buzz-dev-mcp` mounted, `cwd` set to
  a git worktree on a feature branch. Agent has full write access **only within
  the worktree**. Either an explicit open-a-corner command or a human member's
  ALLOW response creates this session. ALLOW replays the concrete request;
  DENY leaves the Room read-only.
- **Workspace supervisor:** one `beeline pair` creates one durable agent
  identity. Humans explicitly invite that existing identity to repository Rooms;
  the supervisor discovers current role projections and starts or drains an
  isolated `Body` for each Room.
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

| Variable                            | Required | Default                 | Description                                                                                      |
| ----------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `BUZZ_AGENT_BIN`                    | No       | explicit reference only | Reference `buzz-agent` override                                                                  |
| `BUZZ_DEV_MCP_BIN`                  | No       | auto-detect             | Path to `buzz-dev-mcp` binary                                                                    |
| `BUZZ_READONLY_MCP_BIN`             | No       | bundled/auto-detect     | Path to Beeline's inspection-only MCP                                                            |
| `BUZZY_RELAY_HOST`                  | No       | `relay.buzzrouter.com`  | Relay HTTP/WS host                                                                               |
| `BUZZY_RELAY_SCHEME`                | No       | `https`                 | Relay scheme                                                                                     |
| `BUZZY_BODY_WORKSPACE`              | No       | `./body-workspace`      | Agent workspace root                                                                             |
| `BUZZY_BODY_LLM_FILE`               | No       | —                       | Path to LLM credentials env file                                                                 |
| `BUZZY_BODY_MAX_SESSIONS`           | No       | `4`                     | Maximum live ACP processes                                                                       |
| `BUZZY_BODY_SESSION_IDLE_MS`        | No       | `300000`                | Idle time before process suspension                                                              |
| `BUZZ_BODY_KEY`                     | No       | auto                    | Body operator Nostr nsec/hex                                                                     |
| `BUZZ_AGENT_KEY`                    | No       | generated at pair       | Existing agent Nostr nsec/hex                                                                    |
| `BUZZY_BODY_AUTO_APPROVE`           | No       | `1`                     | Auto-approve permissions inside edit corners only                                                |
| `BUZZY_BODY_SANDBOX`                | No       | `bwrap`                 | `off` disables the bubblewrap OS sandbox for ACP children (overrides `runtime.json`'s `sandbox`) |
| `BUZZY_GITHUB_APP_ID`               | GitHub   | —                       | Beeline GitHub App id                                                                            |
| `BUZZY_GITHUB_APP_PRIVATE_KEY`      | GitHub   | —                       | App private key used only to mint installation tokens                                            |
| `BUZZY_BODY_SYNC_OPERATOR_CHECKOUT` | No       | `0`                     | `1` opts into clean, same-branch, fast-forward-only post-land pairing-checkout sync              |

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
curl -fsSL https://relay.buzzrouter.com/install | sh
```

The installer selects the platform bundle, verifies its checksum, and installs
`beeline`, `buzz-agent`, `buzz-dev-mcp`, and `buzz-readonly-mcp` under `~/.local`. It is safe to run
again and does not modify any existing `buzz` command. Ensure `~/.local/bin` is
on `PATH`; the installer prints the exact export when it is not.

```bash
# Supported user path: run once from the repository the agent will work in.
# The command redeems the Workspace code, resolves or creates the repo's Room,
# stores machine-only keys under .git, and launches the durable daemon.
# With no --agent flag, Beeline detects Codex, Claude Code, Goose, and Pi.
# Installed agents with a missing ACP adapter remain in the numbered menu and
# offer to install it when selected. Non-interactive runs print the exact manual
# install command and never install packages automatically.
beeline pair BUZZ-XXXX-XXXX

# Piped/non-interactive sessions with several matches must choose explicitly.
beeline pair BUZZ-XXXX-XXXX --agent codex

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

# Inspect today's model calls/tokens, the user event that caused every turn,
# and old-unbounded versus capped session re-prime tokens per daemon restart.
# Adapter-reported usage is exact; fallback estimates are marked with `~`.
beeline spend
beeline spend --day 2026-08-20 --agent <agent-pubkey>
beeline spend --day 2026-08-20 --json

# Provision a read-only agent to a TLC channel
npm run body -- provision <channel-uuid>

# Keep the body attached: addressed chat stays in the read-only Room; human-
# authorized edits use corners, and signed exact-tip approvals land + archive
npm run body -- serve <channel-uuid> <repo-owner-hex> <repo-name>

# Open a subchannel (edit session) under a TLC
npm run body -- open <tlc-uuid> <repo-owner-hex> <repo-name>

# Archive a subchannel
npm run body -- archive <subchannel-uuid>

# Create a new TLC + provision agent (all-in-one)
npm run body -- create-and-provision "my-project"

```

`pair` uses `origin` as the repository identity. HTTPS and SSH clone forms are
normalized and credential material is discarded, so clones of the same remote
in one Workspace converge on one Room. With no `origin`, pairing creates a
local-only Room that deliberately does not converge across machines. A Room has
one immutable repository binding; multiple paired agents in it create parallel
feature branches of that repository.

Pairing is Workspace-scoped, not Room-scoped. To serve another repository Room,
open that Room in the mobile app and tap `＋ Agent`; the human-signed membership
write attaches the already-linked identity using the active Workspace ID. No
second CLI pairing occurs. Removing that membership stops new intake, drains
accepted turns, and releases that Room's processes.

The paired Workspace-member agent creates the Room, makes the pairing human and
a dedicated merge-worker identity admins, and immediately projects itself as a
plain member. The worker discovers every change opened in that Room and lands a
feature tip only after an exact-tip approval from a human admin; agent-signed
approvals remain refused. Both pairing and daemon/`serve` startup assert that the
agent cannot push the protected branch and exit fatally on unsafe policy. The
machine identities, known Room bindings, repo roots, and supervisor state live under
`<git-common-dir>/beeline/agents/<agent-pubkey>/` with mode `0600`. If
`BUZZ_AGENT_KEY` is absent, `pair` generates the agent key there. The daemon is
detached from the invoking terminal, retries transient loop failures, and can be
relaunched with `beeline start`. A restart rediscovers Rooms, restores corner
worktrees and durable inboxes, replays only the capped recent conversation into
fresh ACP processes, and resumes each unfinished human-commissioned corner at
most once in that daemon process. Recaps, moved-target handling, idle ticks, and
failed turns never start model work on their own; another attempt requires a new
human message. `beeline spend` attributes a restart continuation to the original
human request and groups re-prime counts and before/after token sizes by daemon
process generation.

The coding model always comes from the selected operator-owned coding agent. The
explicit `reference` fallback instead uses the operator's local environment or
`BUZZY_BODY_LLM_FILE`; pairing neither requests nor stores a Beeline LLM key.
Souls are separate, human-signed persona overlays. Their name, personality, and
intent are passed directly into ACP session instructions; they are never written
into a repository and cannot grant permissions or approve merges. The remaining
explicit `serve`/`open` commands are internal diagnostic compatibility surfaces,
not part of the user pairing workflow.

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
  isolated worktree directly. Information-only turns reject any model-requested
  mutation without projecting ALLOW. DMs are permanently read-only and cannot
  request or open a corner. A repo-less normal Room may request a corner only by
  naming an exact `owner/repo`; the signed human prompt displays and binds that
  target, and clone/access failures leave the Room read-only. Agent completion
  can publish only the feature ref and `merge-ready`; target landing and archive
  cleanup require an independently verified, exact-tip approval from a
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
- **Permission intent is authority-free:** any current human Room member may
  answer the prompt. The signed response is bound to the agent, permission UUID,
  and original request event; it changes no Room role and grants no merge power.
- **Driving buzz-agent directly:** buzz-acp auto-approves permissions and does
  not expose `session/update` to the relay. The body owns the ACP bridge so it
  can enforce the tool boundary and project activity.
- **Subchannel = child channel:** a new UUID channel (kind:9007) with mirrored
  members, backed by a git worktree. The agent identity creates/owns it; the
  subchannel _is_ the PR.
