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
│                ├── edit mode MCP ──► buzz-dev-mcp            │
│                └── batched session/update ──► relay          │
└──────────────────────────────────────────────────────────────┘
```

- **TLC (read-only):** ACP session with **no MCP mounted** (`mcpServers: []`).
  The agent can converse but has **no shell or file tools**.
- **Subchannel (edit):** ACP session with `buzz-dev-mcp` mounted, `cwd` set to
  a git worktree on a feature branch. Agent has full write access **only within
  the worktree**.
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

## Configuration (env vars)

| Variable                     | Required | Default            | Description                          |
| ---------------------------- | -------- | ------------------ | ------------------------------------ |
| `BUZZ_AGENT_BIN`             | No       | auto-detect        | Path to `buzz-agent` binary          |
| `BUZZ_DEV_MCP_BIN`           | No       | auto-detect        | Path to `buzz-dev-mcp` binary        |
| `BUZZY_RELAY_HOST`           | No       | `127.0.0.1:3010`   | Relay HTTP/WS host                   |
| `BUZZY_RELAY_SCHEME`         | No       | `http`             | Relay scheme                         |
| `BUZZY_BODY_WORKSPACE`       | No       | `./body-workspace` | Agent workspace root                 |
| `BUZZY_BODY_LLM_FILE`        | No       | —                  | Path to LLM credentials env file     |
| `BUZZY_BODY_MAX_SESSIONS`    | No       | `4`                | Maximum live ACP processes           |
| `BUZZY_BODY_SESSION_IDLE_MS` | No       | `300000`           | Idle time before process suspension  |
| `BUZZ_BODY_KEY`              | No       | auto               | Body operator Nostr nsec/hex         |
| `BUZZ_AGENT_KEY`             | No       | generated at pair  | Existing agent Nostr nsec/hex        |
| `BUZZY_BODY_AUTO_APPROVE`    | No       | `1`                | Auto-approve ACP permission requests |
| `BUZZY_SOUL_HOST`            | No       | `127.0.0.1`        | Soul generator bind host             |
| `BUZZY_SOUL_PORT`            | No       | `8789`             | Soul generator port                  |

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
`beeline`, `buzz-agent`, and `buzz-dev-mcp` under `~/.local`. It is safe to run
again and does not modify any existing `buzz` command. Ensure `~/.local/bin` is
on `PATH`; the installer prints the exact export when it is not.

```bash
# Supported user path: run once from the repository the agent will work in.
# The command redeems the Workspace code, resolves or creates the repo's Room,
# stores machine-only keys under .git, and launches the durable daemon.
BUZZY_BODY_LLM_FILE=/path/to/local-model.env \
  beeline pair BUZZ-XXXX-XXXX

# Restart a previously-paired agent after a machine/process restart.
beeline start

# Provision a read-only agent to a TLC channel
npm run body -- provision <channel-uuid>

# Keep the body attached: explicit human @agent requests open agent-owned
# subchannels, steering is forwarded, and merged branches archive automatically
npm run body -- serve <channel-uuid> <repo-owner-hex> <repo-name>

# Open a subchannel (edit session) under a TLC
npm run body -- open <tlc-uuid> <repo-owner-hex> <repo-name>

# Archive a subchannel
npm run body -- archive <subchannel-uuid>

# Create a new TLC + provision agent (all-in-one)
npm run body -- create-and-provision "my-project"

# Serve intent → name/personality generation without exposing the LLM grant
BUZZY_BODY_LLM_FILE=data/buzzy-body/llm-egress.env \
  npm run body -- serve-souls
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
worktrees and durable inboxes, replays isolated conversation history into fresh
ACP processes, and resumes undelivered input without duplicating handled events.

The coding model always comes from the operator's local environment or
`BUZZY_BODY_LLM_FILE`; pairing neither requests nor stores a Beeline LLM key.
Souls are separate, human-signed display overlays and cannot grant permissions
or approve merges. The remaining explicit `serve`/`open` commands are internal
diagnostic compatibility surfaces, not part of the user pairing workflow.

The mobile app calls `POST /v1/souls/generate` with `{ "intent": "..." }`. Set
`EXPO_PUBLIC_BUZZY_SOUL_URL` to this service's public base URL when building or
running the app. The LLM key remains only in the body service environment/file.

### As a library

```typescript
import { Body, loadBodyConfig } from '@beeline/body';
import { newIdentity } from '@beeline/gate';

const config = loadBodyConfig({ workspaceRoot: '/tmp/workspace' });
const body = new Body(config, newIdentity('operator'), newIdentity('coding-agent'));

// Provision read-only agent to a TLC
const session = await body.provision(tlcChannelId);

// Open an edit session under the TLC
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
  enforces read-only by **not mounting** the MCP at all (`mcpServers: []`).
- **Driving buzz-agent directly:** buzz-acp auto-approves permissions and does
  not expose `session/update` to the relay. The body owns the ACP bridge so it
  can enforce the tool boundary and project activity.
- **Subchannel = child channel:** a new UUID channel (kind:9007) with mirrored
  members, backed by a git worktree. The agent identity creates/owns it; the
  subchannel _is_ the PR.
