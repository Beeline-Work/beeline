# @beeline/body — the Buzzy agent body

The operator-run service that gives the coding agent its computer, enforces the
**read-only → edit tool boundary**, and makes the session **multi-user-visible**
by projecting agent activity into the relay channel.

## Architecture

```
┌────────────────────── Body machine ─────────────────────┐
│                                                          │
│  body.ts ──stdlib ACP──► buzz-agent (LLM)                │
│       │                      │                            │
│       │                 MCP stdio (edit mode ONLY)        │
│       │                      ▼                            │
│       │               buzz-dev-mcp (shell/str_replace)    │
│       │                      │                            │
│       └── projects session/update as kind:9 ──► relay    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

- **TLC (read-only):** ACP session with **no MCP mounted** (`mcpServers: []`).
  The agent can converse but has **no shell or file tools**.
- **Subchannel (edit):** ACP session with `buzz-dev-mcp` mounted, `cwd` set to
  a git worktree on a feature branch. Agent has full write access **only within
  the worktree**.
- **Activity projection:** ACP `session/update` notifications are bridged into
  the relay as kind:9 events with `#t=agent-activity`, so **all channel members
  see the agent work live**.
- **Identity boundary:** the operator and agent always have distinct Nostr
  keypairs. The agent signs session activity, control messages, and kind:9007
  subchannel creation. Community-linked TLCs also get a self-signed agent record.

## Prerequisites

1. **Buzz relay** — the local stack or a remote one.

   ```bash
   cd <repo-root> && docker compose -f relay-stack/compose.yml up -d
   ```

2. **Built Rust binaries** — `buzz-agent` and `buzz-dev-mcp`.

   ```bash
   # From the block-buzz checkout (or use prebuilt at .scratch-target/)
   cargo build -p buzz-agent -p buzz-dev-mcp --target-dir .scratch-target
   ```

3. **LLM egress credentials** — set via env or file (see below).

## Configuration (env vars)

| Variable                  | Required | Default            | Description                          |
| ------------------------- | -------- | ------------------ | ------------------------------------ |
| `BUZZ_AGENT_BIN`          | No       | auto-detect        | Path to `buzz-agent` binary          |
| `BUZZ_DEV_MCP_BIN`        | No       | auto-detect        | Path to `buzz-dev-mcp` binary        |
| `BUZZY_RELAY_HOST`        | No       | `127.0.0.1:3010`   | Relay HTTP/WS host                   |
| `BUZZY_RELAY_SCHEME`      | No       | `http`             | Relay scheme                         |
| `BUZZY_BODY_WORKSPACE`    | No       | `./body-workspace` | Agent workspace root                 |
| `BUZZY_BODY_LLM_FILE`     | No       | —                  | Path to LLM credentials env file     |
| `BUZZ_BODY_KEY`           | No       | auto               | Body operator Nostr nsec/hex         |
| `BUZZ_AGENT_KEY`          | No       | generated at pair  | Existing agent Nostr nsec/hex        |
| `BUZZY_BODY_AUTO_APPROVE` | No       | `1`                | Auto-approve ACP permission requests |
| `BUZZY_SOUL_HOST`         | No       | `127.0.0.1`        | Soul generator bind host             |
| `BUZZY_SOUL_PORT`         | No       | `8789`             | Soul generator port                  |

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

```bash
# Supported user path: run once from the repository the agent will work in.
# The command redeems the Workspace code, resolves or creates the repo's Room,
# stores machine-only keys under .git, and launches the durable daemon.
BUZZY_BODY_LLM_FILE=/path/to/local-model.env \
  npm run body -- pair BUZZ-XXXX-XXXX

# Restart a previously-paired agent after a machine/process restart.
npm run body -- start

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

The paired Workspace-member agent creates the Room, makes the pairing human and
a dedicated merge-worker identity admins, and immediately projects itself as a
plain member. The worker discovers every change opened in that Room and lands a
feature tip only after an exact-tip approval from a human admin; agent-signed
approvals remain refused. Both pairing and daemon/`serve` startup assert that the
agent cannot push the protected branch and exit fatally on unsafe policy. The
machine identities, Room ID, repo root, and daemon state live under
`<git-common-dir>/beeline/agents/<agent-pubkey>/` with mode `0600`. If
`BUZZ_AGENT_KEY` is absent, `pair` generates the agent key there. The daemon is
detached from the invoking terminal, retries transient loop failures, and can be
relaunched with `buzz start`. A restart rediscovers the Room and safely dedupes
handled requests; recovery of an already-running ACP edit turn is deferred.

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
