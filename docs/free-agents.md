# Free starter agents

Every newly created Workspace gets one free agent, owned by its creator. It runs
on its own small Fly Machine in the `beeline-free-agents` app, which sleeps after
a minute without work. People who only join an existing Workspace by invite get
none. Code: `apps/server/src/free-agents.ts`, `free-agent-model-proxy.ts`,
`fly-machines.ts`; helper `apps/body/src/free-agent-vm.ts`, `free-agent-idle.ts`;
image `infra/free-agent/`.

New free agents are named **Beebee** and use `@beebee`, with the existing numeric
suffix rule when that handle is already taken. They keep their seeded face and
soul. Existing free agents keep their names.

## Lifecycle

- **Creation.** `PhoneService.createWorkspace` calls `createFreeAgentInWorkspace` in
  the same transaction as `ensureFirstRoom`. That call writes the identity, the agent
  row (harness `pi`, model `beeline/<model>`), the Workspace and `#general`
  memberships, the identity keys sealed with `BEELINE_FREE_AGENT_SEAL_KEY`, a reachable
  presence row and the exact server-authored `FREE_AGENT_HELLO` message in #general.
  The hello tags the owner through the normal mention/push path and uses the
  agent's actual handle. It creates no model turn or Machine. The first real
  queued work provisions the Machine through `FreeAgentService.kick` or the sweep.
  A creator owns at most
  `BEELINE_FREE_AGENT_MAX_PER_OWNER` (default 3) free agents.
- **First boot.** The image builds the thin Beeline helper and its MCP entrypoint
  from its own release SHA, alongside pinned Pi. `entrypoint.sh` starts it without
  downloading a bundle. A helper refused by the server's minimum-version gate
  exits; the entrypoint runs `BEELINE_LAB=1 install.sh` and retries with the
  published bundle. A failed refresh retains the installed helper. The Machine trades its
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
  For every agent, dispatch also writes a working turn before helper pickup.
  A helper claim replaces the reserved `pending:<command id>` generation in
  that same row. If nobody claims it in **90 seconds**, the existing server
  pickup deadline clears the optimistic row and invalidates the Room; the
  command remains available. Optimistic turns are not helper-presence evidence.
  Delayed wakes paint when released; passive computer observations stay silent.
- **Reaper (leader).** A running Machine with no work for 5 minutes is stopped. A
  Machine with no activity for 30 days is deleted. A later wake recreates it from the
  sealed keys (its files are gone).
- **Removal.** The existing Members remove action admits the agent owner or a
  Workspace owner/admin. Removal from any Workspace retires the free-agent runtime,
  matching the existing global daemon retirement. Its transaction keeps a permanent `removed_at` tombstone,
  revokes model/bootstrap and daemon access, and records `removed`. After commit,
  cleanup deletes the Fly Machine without delaying the removal. The leader retries
  failed deletion, including a Machine created by provisioning already in flight.
  Removed agents cannot bootstrap, wake, reap back into service, or be replaced by
  `--add-free-agent` in that Workspace. Beebee's server-posted first hello ends by explaining how
  to remove it from Members.
- **Existing Workspaces.** An operator gives one its free agent with
  `node apps/server/dist/index.js --add-free-agent <workspaceId>` on a server Machine.
  The agent posts the same hello once and boots only for real work. It goes to
  the oldest owner and to `#general`, or to the oldest public
  top-level Room when there is no `#general`.
- **Membership events.** From creation, each free agent's `#general` membership
  carries `event_subscriptions` `joined` and `left`. A join is the existing `joined`
  event. A Room leave or removal already writes a `member-left` or `member-removed`
  line, and `wakeFreeAgentsForLeaves` (run by the leader on every committed message)
  queues one wake on it. No System message producer changed. Leaving the Workspace
  stays silent, as Beeline already decides. An agent joining still wakes the free
  agent, and its instructions say never to greet an agent. The instructions pin the
  owner's exact join greeting (`FREE_AGENT_JOIN_GREETING`, after the joiners'
  @handles) and the exit note (`FREE_AGENT_EXIT_NOTE`). Greetings and notes spend the
  owner's allowance like any turn. Several events while the Machine sleeps are
  coalesced on return into one turn.

Every transition writes `free_agent_events`. These rows are the source of the
rewake latency numbers from `scripts/prove-free-agent.mjs`: created, provisioned,
bootstrapped, connected, sleep_requested, slept, wake_requested, machine_started,
reaped_idle, deleted_idle and allowance_reached.

Existing free agents switch to Pi on their next cold boot. The helper upgrades
the persisted runtime and writes a private Pi provider configuration before
starting sessions. An older image installs the same pinned Pi and pi-acp versions
when those tools are missing. Prior OpenCode harness session history does not carry over;
Workspace messages remain available. Pi and pi-acp state directories are covered
by the existing sandbox binds. The provider pins a 1,000,000-token context window
and a 65,536-token output ceiling.

## Model access and allowances

The Machine never holds a provider key. Pi's `beeline` provider points at
`POST /v1/free-agents/model/chat/completions` with the agent's model token. The
proxy pins `BEELINE_FREE_AGENT_MODEL` (default `deepseek/deepseek-v4.1-flash`). It
forwards to `BEELINE_FREE_AGENT_MODEL_UPSTREAM` (default OpenRouter) with
`BEELINE_FREE_AGENT_MODEL_KEY`, which may be a Squire egress grant. Before each call it
reserves the call's worst case (prompt bound plus a capped reply) against the
owner's daily allowance, under a per-owner lock. Concurrent calls
therefore cannot spend past the cap, and each reply is bounded to the room
left. On completion it settles to the reported usage. A refused call is
refunded, and a reply that broke off keeps its reservation (default 300K tokens
a day). There is no lifetime cap unless `BEELINE_FREE_AGENT_LIFETIME_TOKENS` is
set. A charge
counts uncached prompt tokens plus completion tokens plus `ceil(cached × weight)`.
The cached weight defaults to 0.25 (configurable within 0.10–0.25).
At the cap the proxy answers, in the agent's voice, that the allowance is used
and how to connect the person's own agent.

Model calls require a claimed `input`/`resume` command with a live lease and a
claim younger than the hard turn cap. Pending and completed commands do not
permit calls, including copied model tokens used from outside Beeline. The
helper retains the command claim through model retries and tool follow-ups;
there is no post-completion grace that would authorize idle calls.

A per-owner UTC minute counter defaults to 30 admitted calls, including failed
upstream attempts. Reservations take a global advisory lock before the owner
lock. The shared UTC daily dollar budget defaults to **$25**. Each call reserves
its full uncached prompt and bounded output at configured fallback prices before
contacting the model. Successful calls settle to OpenRouter `usage.cost`, or to
configured input/output prices when cost is absent. Failed upstream calls refund
the reservation; interrupted replies without usage keep it. Each settlement
records `model_usage` (day, charged tokens, USD). A `budget_reached` event records
refused model calls and wakes. At the budget, calls return a first-person pause
message and provisioning/waking cannot start Machines. Queued wakes remain for
the next UTC day. Operators must keep fallback prices at or above their pinned
model's worst-case prices; changing models requires checking these prices.

Prompt reservations count UTF-8 bytes for every allowlisted forwarded field,
including response-format schemas and tool selectors, plus framing overhead. Remote media
cannot be bounded this way and is refused by the free-agent proxy.

Free-agent ACP turns have a hard wall clock cap of **15 minutes**, measured from
local command intake across prompt retries. Activity does not extend it. The
helper cancels the prompt, publishes a short note inviting another message, and
discards the session. The leader reaper cancels overdue claimed commands after
the cap plus 60 seconds of grace and stops their Machine even if it is still
reporting activity. The existing idle, reaper and deletion intervals are unchanged.

At 80% of the daily allowance, settlement writes one private owner/free-agent
DM warning per owner per UTC day, with the midnight UTC reset and a Members ->
Add agent link. Delivery does not call a model. The warning records
`allowance_warning` and `nudge_shown`; pairing a non-free agent in the same
Workspace within 24 hours records `agent_connected_after_nudge` once per agent.
Reaching the Add agent command within 24 hours of a warning records `guide_started`
once per warning. This measures that concrete setup step, not conversational acceptance.
Model-authored nudges are not reliably observable server-side and are not counted.
Instructions limit unsolicited
offers to inaccessible work or the warning, once per UTC day, and guide people
through running their own CLI without requesting or posting pairing codes.
Existing free-agent souls receive the guide during data migration.

## Server configuration

Free agents stay off unless all of these are set: `BEELINE_FREE_AGENTS=1`,
`BEELINE_FREE_AGENT_SEAL_KEY`, `FLY_FREE_AGENT_IMAGE`, `FLY_FREE_AGENT_API_TOKEN`
(scoped to the app), and for the model `BEELINE_FREE_AGENT_MODEL_KEY`. Optional:
`FLY_FREE_AGENT_APP`, `FLY_FREE_AGENT_REGION`, `FLY_FREE_AGENT_CPUS`,
`FLY_FREE_AGENT_MEMORY_MB` (1 shared CPU, 2048 MB: with 1024 MB a Machine with no swap stalled after its first turn),
`BEELINE_FREE_AGENT_SLEEP_MODE` (`suspend` or `stop`),
`BEELINE_FREE_AGENT_IDLE_SECONDS`, `BEELINE_FREE_AGENT_REAP_IDLE_SECONDS`,
`BEELINE_FREE_AGENT_DELETE_AFTER_DAYS`, `BEELINE_FREE_AGENT_DAILY_TOKENS`,
`BEELINE_FREE_AGENT_LIFETIME_TOKENS`,
`BEELINE_FREE_AGENT_CACHED_TOKEN_WEIGHT` (0.25),
`BEELINE_FREE_AGENT_CALLS_PER_MINUTE` (30),
`BEELINE_FREE_AGENT_DAILY_BUDGET_USD` (25),
`BEELINE_FREE_AGENT_INPUT_USD_PER_MILLION` (1),
`BEELINE_FREE_AGENT_OUTPUT_USD_PER_MILLION` (5),
`BEELINE_FREE_AGENT_MAX_TURN_SECONDS` (900), `BEELINE_FREE_AGENT_INSTALL_BASE_URL` and
`FLY_FREE_AGENT_API_ORIGIN` (proofs only). Fly offers no egress firewall for
Machines, so outbound traffic is not restricted. The abuse limits are Machine
size, sleep, the reaper, live turns, owner token/rate limits and the shared dollar budget.

## Image and proofs

The unified release's server leg builds `infra/free-agent/Dockerfile` and pushes
`registry.fly.io/beeline-free-agents:<label>` and `:latest`. A failed push only
warns. `scripts/build-free-agent-image.sh` builds the same image by hand.
`npm run prove:free-agent:docker-machines` stands in for the Machines API with
Docker for a local end-to-end run (suspend = `docker pause`). `npm run
prove:free-agent` runs the end-to-end proof and the rewake latency measurement
against any server whose database it can read.

The image's helper build takes `BEELINE_RELEASE_SHA` and
`BEELINE_RELEASE_VERSION`; the hand-build script supplies the checkout SHA.
`scripts/stage-free-agent-helper.sh` builds the canonical helper bundle from
that checkout. Image construction verifies its SHA, version and digest, then
installs it through the existing recovery installer in an isolated build stage.
`node --test infra/free-agent/entrypoint.test.mjs` exercises both cold-boot paths.
After building the server and image, `node infra/free-agent/cold-start-proof.mjs`
creates a disposable local database and fresh test Workspace, then drives the
real server, image and Pi through a mention and reply. Docker substitutes for
Fly and an immediate local model response substitutes for the provider; the
timed artifact identifies both stand-ins. Set `PROOF_IMAGE` to choose an image.

Reproduction `cold-beebee-first-reply`, Tubing Crew on 2026-10-16: mention
17:52:42Z; Machine booted 17:52:58Z; helper download 17:53:00–17:53:17Z;
Room serving/first activity 17:53:23Z; model catalog 17:53:27Z; first model call
17:54:00Z; reply 17:54:09Z (87 seconds total). Session startup logs UTC timestamps
and monotonic step durations for configuration, home preparation, toolchain,
MCP bridge, ACP initialization and session creation, separating helper
preparation from provider time when investigating the 37-second gap. A local
cold run measured 7,762 ms reinstalling the already-installed Pi/ACP packages
into a Workspace generation. Rooms and corners now use the installed host
harness immediately while that optional immutable generation prepares in the
background. A later cold activation can select the prepared generation;
an active session never switches executables. Free-agent images prepare the exact
version-keyed Pi/ACP generation and the normal 128 MiB recovery reserve during
construction, so a matching image needs neither allocation nor an npm pinning
job on its first turn. Missing or changed generations retain the Workspace
preparation path.
