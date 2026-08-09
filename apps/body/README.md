# @buzzy/body — the Buzzy agent body

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
| `BUZZ_AGENT_KEY`          | No       | auto               | Agent Nostr nsec/hex                 |
| `BUZZY_BODY_AUTO_APPROVE` | No       | `1`                | Auto-approve ACP permission requests |

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
# Provision a read-only agent to a TLC channel
npm run body -- provision <channel-uuid>

# Open a subchannel (edit session) under a TLC
npm run body -- open <tlc-uuid> <repo-owner-hex> <repo-name>

# Archive a subchannel
npm run body -- archive <subchannel-uuid>

# Create a new TLC + provision agent (all-in-one)
npm run body -- create-and-provision "my-project"
```

### As a library

```typescript
import { Body, loadBodyConfig } from '@buzzy/body';
import { newIdentity } from '@buzzy/gate';

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
