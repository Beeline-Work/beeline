# Free starter agents

Every newly created Workspace gets one free agent, owned by its creator. It runs
on its own small Fly Machine in the `beeline-free-agents` app, which sleeps after
a minute without work. People who only join an existing Workspace by invite get
none. Code: `apps/server/src/free-agents.ts`, `free-agent-model-proxy.ts`,
`fly-machines.ts`; helper `apps/body/src/free-agent-vm.ts`, `free-agent-idle.ts`;
image `infra/free-agent/`.

## Lifecycle

- **Creation.** `PhoneService.createWorkspace` calls `createFreeAgentInWorkspace` in
  the same transaction as `ensureFirstRoom`. That call writes the identity, the agent
  row (harness `opencode`, model `beeline/<model>`), the Workspace and `#general`
  memberships, the identity keys sealed with `BEELINE_FREE_AGENT_SEAL_KEY`, a reachable
  presence row and a public `free_agent_hello` wake on the agent's own joined line.
  After commit, `FreeAgentService.kick` creates the Machine. A creator owns at most
  `BEELINE_FREE_AGENT_MAX_PER_OWNER` (default 3) free agents.
- **First boot.** `entrypoint.sh` installs the published helper bundle
  (`BEELINE_LAB=1 install.sh`), then runs `beeline free-agent`. The Machine trades its
  one-time `BEELINE_FREE_AGENT_BOOTSTRAP` at `POST /v1/free-agents/bootstrap`. It gets
  its keys, a fresh daemon exchange token and a revocable model token. The root
  filesystem persists (`rootfs.persist=always`), so later boots skip this step.
- **Sleep.** The helper reports idleness at `POST /v1/free-agents/sleep` 60 s after the
  last turn ends. The server refuses while a wake is pending. Otherwise it records
  `sleeping` and asks Fly to suspend the Machine. If suspend fails, it stops the
  Machine. A helper behind the announced release asks for `refresh` and gets a stop,
  so its next boot installs the new release. The helper never updates in place.
- **Wake.** Every committed `agent_commands` INSERT for a free agent calls
  `FreeAgentService.wake`, and the leader sweep retries every 15 s. Wakes are never
  suppressed for an offline Machine (`agentMachineOfflineSql` exempts free agents). A
  released connection keeps presence `online`, `held`, `asleep`, so mentions never get
  "its helper is offline". On resume the helper sees the wall clock jump past its
  monotonic clock. It then replaces its socket at once (`LiveLink.reconnectNow`).
- **Reaper (leader).** A running Machine with no work for 5 minutes is stopped. A
  Machine with no activity for 30 days is deleted. A later wake recreates it from the
  sealed keys (its files are gone). Retiring the agent itself is not implemented and
  needs a human decision.
- **Existing Workspaces.** An operator gives one its free agent with
  `node apps/server/dist/index.js --add-free-agent <workspaceId>` on a server Machine.
  The agent goes to the oldest owner and to `#general`, or to the oldest public
  top-level Room when there is no `#general`.
- **Untagged replies.** The owner's untagged message in a top-level Room wakes their
  free agent when it is that Room's only agent.

Every transition writes `free_agent_events`. These rows are the source of the
rewake latency numbers from `scripts/prove-free-agent.mjs`: created, provisioned,
bootstrapped, connected, sleep_requested, slept, wake_requested, machine_started,
reaped_idle, deleted_idle and allowance_reached.

## Model access and allowances

The Machine never holds a provider key. OpenCode's `beeline` provider points at
`POST /v1/free-agents/model/chat/completions` with the agent's model token. The
proxy pins `BEELINE_FREE_AGENT_MODEL` (default `deepseek/deepseek-v4-flash`). It
forwards to `BEELINE_FREE_AGENT_MODEL_UPSTREAM` (default OpenRouter) with
`BEELINE_FREE_AGENT_MODEL_KEY`, which may be a Squire egress grant. It charges the
owner's account per UTC day and for life (defaults 300K and 3M tokens). A charge
counts uncached prompt tokens plus completion tokens; cached prompt reads are free.
At either cap the proxy answers, in the agent's voice, that the allowance is used
and how to connect the person's own agent.

## Server configuration

Free agents stay off unless all of these are set: `BEELINE_FREE_AGENTS=1`,
`BEELINE_FREE_AGENT_SEAL_KEY`, `FLY_FREE_AGENT_IMAGE`, `FLY_FREE_AGENT_API_TOKEN`
(scoped to the app), and for the model `BEELINE_FREE_AGENT_MODEL_KEY`. Optional:
`FLY_FREE_AGENT_APP`, `FLY_FREE_AGENT_REGION`, `FLY_FREE_AGENT_CPUS`,
`FLY_FREE_AGENT_MEMORY_MB` (1 shared CPU, 1024 MB),
`BEELINE_FREE_AGENT_SLEEP_MODE` (`suspend` or `stop`),
`BEELINE_FREE_AGENT_IDLE_SECONDS`, `BEELINE_FREE_AGENT_REAP_IDLE_SECONDS`,
`BEELINE_FREE_AGENT_DELETE_AFTER_DAYS`, `BEELINE_FREE_AGENT_DAILY_TOKENS`,
`BEELINE_FREE_AGENT_LIFETIME_TOKENS`, `BEELINE_FREE_AGENT_INSTALL_BASE_URL` and
`FLY_FREE_AGENT_API_ORIGIN` (proofs only). Fly offers no egress firewall for
Machines, so outbound traffic is not restricted. The abuse limits are Machine
size, sleep, the reaper and the token allowances.

## Image and proofs

The unified release's server leg builds `infra/free-agent/Dockerfile` and pushes
`registry.fly.io/beeline-free-agents:<label>` and `:latest`. A failed push only
warns. `scripts/build-free-agent-image.sh` builds the same image by hand.
`npm run prove:free-agent:docker-machines` stands in for the Machines API with
Docker for a local end-to-end run (suspend = `docker pause`). `npm run
prove:free-agent` runs the end-to-end proof and the rewake latency measurement
against any server whose database it can read.
