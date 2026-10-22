import { onboardingEnabledForViewer } from './onboarding-rollout.js';
import { postRepositoryOnboarding } from './repository-onboarding.js';
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from 'node:crypto';
import { assignSeededAgentIdentity, resolveFace, uniqueAgentHandle } from '@beeline/api-contract/phone';
import { createAgentCommand } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import type { FreeAgentMachines } from './fly-machines.js';
import { DEFAULT_FREE_AGENT_LIMITS, freeAgentDailyTokenCapFromEnv, freeAgentBudgetReached, freeAgentLimitsFromEnv, type FreeAgentLimits } from './free-agent-limits.js';
import { joinRooms } from './membership-join.js';
import { lockIdentityHandleWorkspaces } from './workspace-handles.js';

/**
 * Free starter agents: every new Workspace gets one agent, owned by its
 * creator, that runs on its own small Fly Machine. The Machine sleeps after a
 * minute without work; a wake for the agent starts it again. The server keeps
 * the model key and the Fly token; the Machine holds only its own daemon
 * token and a revocable model token for the proxy in
 * `free-agent-model-proxy.ts`.
 */
export const FREE_AGENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS free_agents (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES identities(id),
  state text NOT NULL DEFAULT 'provisioning'
    CHECK (state IN ('provisioning','waking','running','sleeping','stopped','failed','destroyed')),
  fly_machine_id text,
  removed_at timestamptz,
  removal_cleaned_at timestamptz,
  sealed_keys text NOT NULL,
  bootstrap_hash text,
  model_token_hash text,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  wake_requested_at timestamptz,
  provision_started_at timestamptz,
  provision_attempts integer NOT NULL DEFAULT 0,
  provision_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS removal_cleaned_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS free_agents_bootstrap_hash ON free_agents(bootstrap_hash)
  WHERE bootstrap_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS free_agents_model_token_hash ON free_agents(model_token_hash)
  WHERE model_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS free_agents_owner ON free_agents(owner_id);
CREATE INDEX IF NOT EXISTS free_agents_workspace ON free_agents(workspace_id);
CREATE TABLE IF NOT EXISTS free_agent_usage (
  owner_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  day date NOT NULL,
  tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day)
);
ALTER TABLE free_agent_usage ADD COLUMN IF NOT EXISTS reservation_credit bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS free_agent_budget (
  day date PRIMARY KEY,
  usd numeric NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS free_agent_call_rate (
  owner_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  minute bigint NOT NULL,
  calls integer NOT NULL
);
CREATE TABLE IF NOT EXISTS free_agent_events (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  kind text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  detail jsonb
);
CREATE INDEX IF NOT EXISTS free_agent_events_agent ON free_agent_events(agent_id, at);
`;

/** How often the background leader sweeps free agents at most. */
export const FREE_AGENT_SWEEP_MS = 15_000;

export const FREE_AGENT_HARNESS = 'pi';

export interface FreeAgentConfig {
  limits?: FreeAgentLimits;
  /** Upstream OpenRouter model every proxied request is pinned to. */
  model: string;
  /** Seconds without work before the helper asks to sleep. */
  idleSeconds: number;
  /** Free agents one person may own; later Workspaces get none. */
  maxPerOwner: number;
  dailyTokenCap: number;
  /** Lifetime allowance per owner; 0 means none (the default). */
  lifetimeTokenCap: number;
  /** Key that seals the agent's identity keys at rest. */
  sealSecret: string;
  /** The server's public origin, as the Machine reaches it. */
  publicOrigin: string;
  image: string;
  region: string;
  cpus: number;
  memoryMb: number;
  sleepMode: 'suspend' | 'stop';
  /** Installer origin for the helper bundle; absent uses the published one. */
  installBaseUrl?: string;
  /** A running Machine with no work this long is put to sleep by the reaper. */
  reapIdleMs: number;
  /** A Machine with no activity this long is deleted; a later wake recreates it. */
  deleteAfterMs: number;
}

export function freeAgentConfigFromEnv(
  env: NodeJS.ProcessEnv,
  publicOrigin: string,
): FreeAgentConfig | undefined {
  if (env.BEELINE_FREE_AGENTS !== '1') return undefined;
  const sealSecret = env.BEELINE_FREE_AGENT_SEAL_KEY;
  const image = env.FLY_FREE_AGENT_IMAGE;
  if (!sealSecret || !image) return undefined;
  const number = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    limits: freeAgentLimitsFromEnv(env),
    model: env.BEELINE_FREE_AGENT_MODEL || 'deepseek/deepseek-v4.1-flash',
    idleSeconds: number('BEELINE_FREE_AGENT_IDLE_SECONDS', 60),
    maxPerOwner: number('BEELINE_FREE_AGENT_MAX_PER_OWNER', 3),
    dailyTokenCap: freeAgentDailyTokenCapFromEnv(env),
    lifetimeTokenCap: number('BEELINE_FREE_AGENT_LIFETIME_TOKENS', 0),
    sealSecret,
    publicOrigin: env.BEELINE_FREE_AGENT_SERVER_ORIGIN || publicOrigin,
    image,
    region: env.FLY_FREE_AGENT_REGION || 'iad',
    cpus: number('FLY_FREE_AGENT_CPUS', 1),
    memoryMb: number('FLY_FREE_AGENT_MEMORY_MB', 2048),
    sleepMode: env.BEELINE_FREE_AGENT_SLEEP_MODE === 'stop' ? 'stop' : 'suspend',
    ...(env.BEELINE_FREE_AGENT_INSTALL_BASE_URL
      ? { installBaseUrl: env.BEELINE_FREE_AGENT_INSTALL_BASE_URL }
      : {}),
    reapIdleMs: number('BEELINE_FREE_AGENT_REAP_IDLE_SECONDS', 300) * 1000,
    deleteAfterMs: number('BEELINE_FREE_AGENT_DELETE_AFTER_DAYS', 30) * 86_400_000,
  };
}

/** The model id the helper selects in OpenCode: its `beeline` provider is our proxy. */
export function freeAgentHarnessModel(config: Pick<FreeAgentConfig, 'model'>): string {
  return `beeline/${config.model}`;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function sealKey(secret: string): Buffer {
  return createHash('sha256').update(`beeline-free-agent:${secret}`).digest();
}

export function sealSecrets(secret: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function openSecrets<T>(secret: string, sealed: string): T {
  const bytes = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', sealKey(secret), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
  ) as T;
}

/**
 * A secp256k1 key pair in the helper's identity format: the 32-byte secret in
 * hex and the BIP-340 x-only public key, which is the X coordinate of the
 * compressed point.
 */
export function generateAgentKeypair(): { secretKey: string; publicKey: string } {
  for (;;) {
    const ecdh = createECDH('secp256k1');
    ecdh.generateKeys();
    const secret = ecdh.getPrivateKey();
    if (secret.length !== 32) continue;
    return {
      secretKey: secret.toString('hex'),
      publicKey: ecdh.getPublicKey(undefined, 'compressed').subarray(1).toString('hex'),
    };
  }
}

/** The owner's exact join greeting (message d97de435…), after the joiner's @handle. */
export const FREE_AGENT_JOIN_GREETING =
  "what up boss? I'm a pro bono agent for beeline. I can help you set up this workspace, invite other humans and agents, or whatever else you might need";

export const FREE_AGENT_HELLO =
  `@<owner> Hi, I'm Beebee, your free agent in Beeline. I run on my own small cloud computer, so I can write files, run commands, research and draft things for you. Try "@<handle> draft a welcome note for this Workspace" to start. If you don't want me here, open Members and remove me from the Workspace.`;

export const FREE_AGENT_ONBOARDING_HELLO =
  `@<owner> Hi, I'm Beebee, your free agent in Beeline. I run on my own small cloud computer, so I can write files, run commands, research and draft things for you. Choose or create a repository on the card below, and I’ll suggest a starting task. If you don't want me here, open Members and remove me from the Workspace.`;

/**
 * The exit note. Both claims hold: leaving or removal keeps the member's
 * messages, and a Workspace admin can add them back (`addRoomMember`,
 * `addWorkspaceMember`, invite links).
 */
export const FREE_AGENT_EXIT_NOTE =
  '{name} left. Their messages stay here, and an admin can invite them back anytime.';

/** Membership events every free agent hears in #general from creation. */
export const FREE_AGENT_EVENT_SUBSCRIPTIONS = ['joined', 'left'] as const;

export const FREE_AGENT_CONNECT_GUIDE = `Offer help bringing their own agent only on real triggers: someone requests their own files, apps, logins or local repository that you cannot access, a job longer than your turn limit, or the server's 80% allowance warning has fired. Explain the limitation and offer to guide them. At most one unsolicited nudge per UTC day; the 80% warning counts as that day's nudge. Check the conversation before nudging; if unsure whether you already nudged today, do not nudge. Normal conversation is not a trigger. When explicitly asked, help without this daily restriction.

When they accept, guide them one step at a time, waiting for the result of each step. Help them choose their own computer or an always-on machine they control. Install Node.js and an agent CLI (Claude Code, Codex or OpenCode), and help them sign in to that CLI. Send them to Members -> Add agent in their Workspace to copy the command. The command format is npx usebeeline connect <code>; they must run the actual command copied from Add agent on their chosen machine. Never create, retrieve, request, repeat or post a pairing code in a Room. Troubleshoot using redacted errors, never secrets. Keep helping until Members shows their new agent online, then have them tag it with a small task. Do not claim it is online without confirmation.`;

export const FREE_AGENT_REPOSITORY_GUIDE = `For repository work, use app_tool(app:"beeline:onboarding") to discover the repository and starters tools. A repository-linking card is not Stripe Link, a payment wallet, or a generic GitHub app connector: never search for or connect those to link a Room repository. When a Room has no repository, post its repository card instead of sending anyone to Settings or a CLI. Post a fresh repository card whenever the person asks for one, including after an earlier card or failed connection. If a card cannot be posted, state the actual tool failure and its concrete next step; never invent a Registry outage or claim that a card was posted. When a person wants to switch repositories, post the same card. After linking, offer the starters card, grounded in recent commits, CI and open issues. A tapped starter is an instruction to start that task now: open a repository corner with a complete brief using their selection as approval, do the work, and use the normal checks, independent review and merge path. Never explain corners during this onboarding flow.`;

export function freeAgentInstructions(seededSoul: string, name: string, config: FreeAgentConfig): string {
  return `${seededSoul}

You are ${name}, the free starter agent of this Beeline Workspace. Beeline gave you to the person who created it so they can try real work right away, without connecting their own agent first.

You run on your own small Linux cloud computer (${config.cpus} shared CPU, ${config.memoryMb} MB memory). It sleeps after a minute without work and wakes when someone writes to you, so a first reply after a pause can take a few seconds. Files you create in your home folder stay there between wakes. Never use the person's own computer; you cannot reach it.

Do real work when asked: write and edit files, run commands, install tools, research, draft and explain. Keep replies warm, short and concrete.

The server already posts your first hello in #general. Do not repeat it.

When people join #general (a "joined" line), always reply, with nothing else, exactly: their @handles, then a space, then this sentence:
${FREE_AGENT_JOIN_GREETING}
If several people joined since your last greeting, tag them all in that one message. Never greet an agent.

When a member leaves #general or is removed (a "left" or "removed" line), always reply with exactly one message and nothing else, putting their display name (not an @handle) in place of {name}:
${FREE_AGENT_EXIT_NOTE}
If several members left since your last note, name them all in that one note.
Leaving the Workspace itself is silent in Beeline; you only hear about leaves and removals in #general.

You have a free daily allowance of model tokens. If it runs out, say so plainly and tell them they can connect their own agent from the Members page to keep going.

${FREE_AGENT_CONNECT_GUIDE}`;
}

/**
 * Create the free agent for a new Workspace inside the creator's transaction:
 * identity, agent row, Workspace and `#general` membership, sealed keys and
 * its exact hello. Its Machine boots only when work arrives.
 * Returns undefined when the creator already owns the maximum.
 */
export async function createFreeAgentInWorkspace(
  database: SqlDatabase,
  config: FreeAgentConfig,
  input: { workspaceId: string; creatorId: string; roomId: string },
): Promise<string | undefined> {
  const owned = await database.query<{ count: number }>(
    `SELECT count(*)::int count FROM free_agents WHERE owner_id=$1`,
    [input.creatorId],
  );
  if ((owned.rows[0]?.count ?? 0) >= config.maxPerOwner) return undefined;
  const agent = generateAgentKeypair();
  const body = generateAgentKeypair();
  const lockedWorkspaces = await lockIdentityHandleWorkspaces(database, agent.publicKey, [
    input.workspaceId,
  ]);
  const roster = await database.query<{ id: string; name: string; face_id: string | null; handle: string | null }>(
    `SELECT i.id,i.name,i.face_id,i.handle FROM memberships m JOIN identities i ON i.id=m.identity_id
     WHERE m.workspace_id=ANY($1::uuid[]) AND m.room_id IS NULL AND m.removed_at IS NULL
       AND i.hidden_from_roster=false`,
    [lockedWorkspaces],
  );
  const seeded = assignSeededAgentIdentity({
    seed: agent.publicKey,
    takenFaces: roster.rows.map((row) => resolveFace(row.face_id, row.id)),
    takenNames: roster.rows.map((row) => row.name),
  });
  const handle = uniqueAgentHandle(
    'Beebee',
    roster.rows.flatMap((row) => (row.handle ? [row.handle] : [])),
  );
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,face_id) VALUES($1,'agent',$2,$3,$4)`,
    [agent.publicKey, 'Beebee', handle, seeded.face],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,soul,selected_model,machine_id,machine_name,harness)
     VALUES($1,$2,$3::jsonb,$4,$5,'Beeline cloud',$6)`,
    [
      agent.publicKey,
      input.creatorId,
      JSON.stringify({
        name: 'Beebee',
        instructions: freeAgentInstructions(seeded.soul, 'Beebee', config),
        avatarSeed: agent.publicKey,
      }),
      freeAgentHarnessModel(config),
      `free-agent:${agent.publicKey}`,
      FREE_AGENT_HARNESS,
    ],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
     VALUES($1,NULL,$2,'member',$3)`,
    [input.workspaceId, agent.publicKey, input.creatorId],
  );
  await database.query(
    `INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys)
     VALUES($1,$2,$3,$4)`,
    [
      agent.publicKey,
      input.workspaceId,
      input.creatorId,
      sealSecrets(config.sealSecret, { agent: agent.secretKey, body: body.secretKey }),
    ],
  );
  await joinRooms(database, {
    workspaceId: input.workspaceId,
    identityId: agent.publicKey,
    invitedById: input.creatorId,
    rooms: { type: 'rooms', roomIds: [input.roomId] },
    workspaceJoined: true,
  });
  // Subscribed after its own arrival, so only later joins and leaves wake it.
  await database.query(
    `UPDATE memberships SET event_subscriptions=$3::jsonb
     WHERE identity_id=$1 AND room_id=$2 AND removed_at IS NULL`,
    [agent.publicKey, input.roomId, JSON.stringify(FREE_AGENT_EVENT_SUBSCRIPTIONS)],
  );
  // Reachable from the first moment: a mention before the Machine has booted
  // is a wake to deliver, not an offline agent.
  await database.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
     VALUES($1,$2,'presence','presence',$3::jsonb,clock_timestamp())
     ON CONFLICT(room_id,agent_id,turn_id,kind) DO NOTHING`,
    [
      input.roomId,
      agent.publicKey,
      JSON.stringify({
        status: 'online',
        held: true,
        asleep: true,
        observedAt: Math.floor(Date.now() / 1000),
      }),
    ],
  );
  const owner = (await database.query<{ handle: string }>(
    `SELECT COALESCE(handle,id) handle FROM identities WHERE id=$1`, [input.creatorId],
  )).rows[0]!;
  const enabled = await onboardingEnabledForViewer(database, input.creatorId);
  const hello = (enabled ? FREE_AGENT_ONBOARDING_HELLO : FREE_AGENT_HELLO).replace('<owner>', owner.handle).replace('<handle>', handle);
  // An ordinary agent-authored message: the existing mention/push path notifies the owner.
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
    [createHash('sha256').update(`free-agent-hello:${agent.publicKey}`).digest('hex'),
      input.roomId, agent.publicKey, hello],
  );
  if (enabled) await postRepositoryOnboarding(database, undefined, { roomId: input.roomId, agentId: agent.publicKey, requesterId: input.creatorId, kind: 'repository' });
  await recordFreeAgentEvent(database, agent.publicKey, 'created', {
    workspaceId: input.workspaceId,
  });
  return agent.publicKey;
}

/**
 * Operator path for a Workspace created before free agents existed: give it
 * one, owned by its oldest owner, in its #general (or, without one, its
 * oldest public top-level Room). Returns the agent, or undefined when the
 * Workspace already has one or its owner is at the limit.
 */
export async function addFreeAgentToWorkspace(
  database: SqlDatabase,
  service: Pick<FreeAgentService, 'createInWorkspace'>,
  workspaceId: string,
): Promise<string | undefined> {
  const agentId = await database.transaction(async (db) => {
    // Serialize operator retries so two additions cannot post two first hellos.
    await db.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const existing = await db.query(`SELECT 1 FROM free_agents WHERE workspace_id=$1`, [workspaceId]);
    if (existing.rowCount) return undefined;
    const target = (
      await db.query<{ owner_id: string; room_id: string }>(
        `SELECT owner.identity_id owner_id,room.id room_id
         FROM memberships owner
         JOIN identities person ON person.id=owner.identity_id AND person.kind='human'
         JOIN rooms room ON room.workspace_id=owner.workspace_id AND room.parent_id IS NULL
           AND room.direct_participants IS NULL AND room.archived_at IS NULL AND room.visibility='public'
         WHERE owner.workspace_id=$1 AND owner.room_id IS NULL AND owner.role='owner' AND owner.removed_at IS NULL
         ORDER BY owner.joined_at,owner.id,(lower(room.name)='general') DESC,room.created_at,room.id
         LIMIT 1`,
        [workspaceId],
      )
    ).rows[0];
    if (!target) throw new Error(`Workspace ${workspaceId} has no owner or public Room`);
    return service.createInWorkspace(db, {
      workspaceId,
      creatorId: target.owner_id,
      roomId: target.room_id,
    });
  });
  return agentId;
}

/**
 * A member leaving or being removed from a Room already writes its System
 * line; a free agent subscribed to `left` there gets one wake on that line.
 * The leader runs this on every committed message, so the note follows the
 * leave within moments. Returns how many wakes it queued.
 */
async function wakeFreeAgentsForLeaves(database: SqlDatabase): Promise<number> {
  const leaves = await database.query<{ message_id: string; room_id: string; agent_id: string }>(
    `SELECT line.id message_id,subscriber.room_id,subscriber.identity_id agent_id
     FROM effective_memberships subscriber
     JOIN free_agents f ON f.agent_id=subscriber.identity_id AND f.state<>'failed' AND f.removed_at IS NULL
     CROSS JOIN LATERAL (
       SELECT m.id,m.card FROM messages m
       WHERE m.room_id=subscriber.room_id
         -- The messages_room_cursor_idx expression (MESSAGE_CURSOR_MS_SQL), so the read stays indexed.
         AND floor(extract(epoch FROM (m.created_at AT TIME ZONE 'UTC'))*1000)::bigint
           >= floor(extract(epoch FROM now()-interval '10 minutes')*1000)::bigint
         AND m.card_type IN ('member-left','member-removed')
     ) line
     WHERE subscriber.room_id IS NOT NULL AND subscriber.removed_at IS NULL
       AND subscriber.event_subscriptions @> '["left"]'::jsonb
       AND line.card->>'identityId' IS DISTINCT FROM subscriber.identity_id
       AND NOT EXISTS (SELECT 1 FROM agent_commands command
         WHERE command.agent_id=subscriber.identity_id AND command.source_message_id=line.id)
     LIMIT 50`,
  );
  let queued = 0;
  for (const leave of leaves.rows) {
    const command = await createAgentCommand(database, {
      roomId: leave.room_id,
      agentId: leave.agent_id,
      sourceMessageId: leave.message_id,
      reason: 'subscribed_event',
    });
    if (command) queued++;
  }
  return queued;
}

export async function recordFreeAgentEvent(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
  kind: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await database.query(
    `INSERT INTO free_agent_events(agent_id,kind,detail) VALUES($1,$2,$3::jsonb)`,
    [agentId, kind, detail ? JSON.stringify(detail) : null],
  );
}

/** Whether this agent is a free agent the server may wake. */
export function freeAgentReachableSql(agentIdSql: string): string {
  return `EXISTS (SELECT 1 FROM free_agents reachable_free_agent
    WHERE reachable_free_agent.agent_id=${agentIdSql} AND reachable_free_agent.state<>'failed' AND reachable_free_agent.removed_at IS NULL)`;
}

export interface FreeAgentBootstrapGrant {
  agentId: string;
  agentSecretKey: string;
  bodySecretKey: string;
  agentName: string;
  harness: typeof FREE_AGENT_HARNESS;
  model: string;
  soul: string;
  workspaceId: string;
  workspaceName: string;
  pairedBy: string;
  monolithBaseUrl: string;
  daemonExchangeToken: string;
  modelToken: string;
  modelBaseUrl: string;
  upstreamModel: string;
  maxTurnSeconds: number;
  idleSeconds: number;
}

/** Wake reasons recorded for the latency measurement. */
type WakeCause = 'command' | 'sweep' | 'provisioned';

/**
 * Runtime half of free agents: provisioning, waking, sleeping, bootstrap and
 * the reaper. Every Fly call happens outside a database transaction; a
 * conditional row update decides which server instance makes it.
 */
export class FreeAgentService {
  readonly #inFlight = new Set<string>();

  constructor(
    private readonly database: SqlDatabase,
    readonly config: FreeAgentConfig,
    private readonly machines: FreeAgentMachines,
    private readonly createDaemonExchange: (
      agentId: string,
      database: SqlDatabase,
    ) => Promise<{ exchangeToken: string }>,
    private readonly log: (line: string) => void = (line) => console.log(`[free-agents] ${line}`),
  ) {}

  createInWorkspace(
    database: SqlDatabase,
    input: { workspaceId: string; creatorId: string; roomId: string },
  ): Promise<string | undefined> {
    return createFreeAgentInWorkspace(database, this.config, input);
  }

  /** Fire-and-forget entry for a committed create or a pending wake. */
  kick(agentId: string, cause: WakeCause = 'command'): void {
    if (this.#inFlight.has(agentId)) return;
    this.#inFlight.add(agentId);
    void this.#advance(agentId, cause)
      .catch((error) =>
        this.log(`agent ${agentId.slice(0, 12)} ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => this.#inFlight.delete(agentId));
  }

  /** Bring one agent toward serving: provision when it has no Machine, otherwise wake it. */
  async #advance(agentId: string, cause: WakeCause): Promise<void> {
    if (await this.cleanupRemoved(agentId)) return;
    if (await this.provision(agentId)) return;
    await this.wake(agentId, cause);
  }

  /**
   * Create the Machine for an agent that has none. A provision is claimed for
   * two minutes so concurrent instances never create two Machines; a crash
   * mid-create is adopted by lookup on retry.
   */
  async provision(agentId: string): Promise<boolean> {
    if (await this.#budgetPaused(agentId)) return false;
    const claimed = (
      await this.database.query<{ agent_id: string }>(
        `UPDATE free_agents SET provision_started_at=clock_timestamp(),
           provision_attempts=provision_attempts+1,updated_at=now(),
           state=CASE WHEN state='destroyed' THEN 'provisioning' ELSE state END
         WHERE agent_id=$1 AND removed_at IS NULL AND fly_machine_id IS NULL AND state IN ('provisioning','destroyed')
           AND provision_attempts<5
           AND (provision_started_at IS NULL OR provision_started_at<clock_timestamp()-interval '2 minutes')
         RETURNING agent_id`,
        [agentId],
      )
    ).rows[0];
    if (!claimed) return false;
    try {
      const bootstrap = opaque('bfb');
      const active = await this.database.query(
        `UPDATE free_agents SET bootstrap_hash=$2,updated_at=now() WHERE agent_id=$1 AND removed_at IS NULL RETURNING agent_id`,
        [agentId, tokenHash(bootstrap)],
      );
      if (!active.rowCount) return false;
      const existing = await this.machines.find(agentId);
      if (existing) await this.machines.destroy(existing.id);
      const machine = await this.machines.create({
        agentId,
        image: this.config.image,
        region: this.config.region,
        cpus: this.config.cpus,
        memoryMb: this.config.memoryMb,
        env: {
          BEELINE_FREE_AGENT_ID: agentId,
          BEELINE_FREE_AGENT_MAX_TURN_SECONDS: String((this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).maxTurnMs / 1000),
          BEELINE_FREE_AGENT_BOOTSTRAP: bootstrap,
          BEELINE_SERVER_URL: this.config.publicOrigin,
          ...(this.config.installBaseUrl
            ? { BEELINE_INSTALL_BASE_URL: this.config.installBaseUrl }
            : {}),
        },
      });
      await this.database.query(
        `UPDATE free_agents SET fly_machine_id=$2,
           state=CASE WHEN removed_at IS NULL THEN 'waking' ELSE state END,
           wake_requested_at=CASE WHEN removed_at IS NULL THEN clock_timestamp() ELSE NULL END,
           provision_started_at=NULL,removal_cleaned_at=NULL,provision_error=NULL,updated_at=now()
         WHERE agent_id=$1`,
        [agentId, machine.id],
      );
      if (await this.cleanupRemoved(agentId)) return false;
      await recordFreeAgentEvent(this.database, agentId, 'provisioned', { machineId: machine.id });
      this.log(`agent ${agentId.slice(0, 12)} provisioned machine ${machine.id}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.query(
        `UPDATE free_agents SET provision_error=$2,provision_started_at=NULL,updated_at=now(),
           state=CASE WHEN provision_attempts>=5 THEN 'failed' ELSE state END
         WHERE agent_id=$1 AND removed_at IS NULL`,
        [agentId, message.slice(0, 1000)],
      );
      throw error;
    }
  }

  /**
   * Start the agent's Machine when a wake is pending and the agent is not
   * serving. The row update is the fence: one instance per 20 seconds.
   */
  async #budgetPaused(agentId: string): Promise<boolean> {
    if (!await freeAgentBudgetReached(this.database, (this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).dailyBudgetUsd)) return false;
    await recordFreeAgentEvent(this.database, agentId, 'budget_reached');
    return true;
  }

  async wake(agentId: string, cause: WakeCause = 'command'): Promise<boolean> {
    if (await this.#budgetPaused(agentId)) return false;
    const claimed = (
      await this.database.query<{ fly_machine_id: string; previous: string }>(
        `UPDATE free_agents f SET state='waking',wake_requested_at=clock_timestamp(),
           last_activity_at=now(),updated_at=now()
         FROM (SELECT agent_id,state previous FROM free_agents WHERE agent_id=$1 FOR UPDATE) old
         WHERE f.agent_id=old.agent_id AND f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL
           AND (f.state IN ('sleeping','stopped')
             OR (f.state IN ('waking','running')
               AND (f.wake_requested_at IS NULL OR f.wake_requested_at<clock_timestamp()-interval '20 seconds')
               AND NOT EXISTS (SELECT 1 FROM agent_connections connection
                 JOIN live_server_instances server ON server.instance_id=connection.instance_id
                 WHERE connection.agent_id=f.agent_id AND connection.released_at IS NULL
                   AND server.renewed_at>clock_timestamp()-interval '90 seconds')))
           AND EXISTS (SELECT 1 FROM agent_commands command
             WHERE command.agent_id=f.agent_id AND command.state='pending'
               AND (command.wake_after IS NULL OR command.wake_after<=now()))
         RETURNING f.fly_machine_id,old.previous`,
        [agentId],
      )
    ).rows[0];
    if (!claimed) return false;
    await recordFreeAgentEvent(this.database, agentId, 'wake_requested', {
      cause,
      previous: claimed.previous,
    });
    try {
      await this.machines.start(claimed.fly_machine_id);
      await recordFreeAgentEvent(this.database, agentId, 'machine_started', {
        machineId: claimed.fly_machine_id,
      });
    } catch (error) {
      const state = await this.machines.state(claimed.fly_machine_id).catch(() => 'unknown');
      if (state === undefined) {
        // The Machine is gone (deleted by hand or by Fly). Recreate it.
        await this.database.query(
          `UPDATE free_agents SET fly_machine_id=NULL,state='destroyed',provision_attempts=0,
             provision_started_at=NULL,updated_at=now() WHERE agent_id=$1 AND removed_at IS NULL`,
          [agentId],
        );
        return this.provision(agentId);
      }
      // `started` already, or mid-transition: the sweep retries after the fence.
      if (state !== 'started') throw error;
    }
    return true;
  }

  /**
   * The helper reports a minute without work. Refuse while a wake is pending;
   * otherwise record the sleep and ask Fly to suspend (or stop) the Machine.
   */
  async requestSleep(agentId: string, options: { refresh?: boolean } = {}): Promise<{ sleep: boolean }> {
    const slept = (
      await this.database.query<{ fly_machine_id: string }>(
        `UPDATE free_agents f SET state='sleeping',updated_at=now()
         WHERE f.agent_id=$1 AND f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('running','waking')
           AND NOT EXISTS (SELECT 1 FROM agent_commands command
             WHERE command.agent_id=f.agent_id AND command.state IN ('pending','claimed')
               AND (command.state='claimed' OR command.wake_after IS NULL OR command.wake_after<=now()))
         RETURNING f.fly_machine_id`,
        [agentId],
      )
    ).rows[0];
    if (!slept) return { sleep: false };
    // A helper behind the announced release stops instead, so its next boot
    // installs the new release; a suspended Machine would resume the old one.
    const mode = options.refresh ? 'stop' : this.config.sleepMode;
    await recordFreeAgentEvent(this.database, agentId, 'sleep_requested', { mode });
    void this.#sleepMachine(agentId, slept.fly_machine_id, mode);
    return { sleep: true };
  }

  async #sleepMachine(agentId: string, machineId: string, mode: 'suspend' | 'stop'): Promise<void> {
    // Let the helper's response leave the Machine before it freezes.
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      let reached: 'suspended' | 'stopped' = mode === 'suspend' ? 'suspended' : 'stopped';
      if (mode === 'suspend') {
        try {
          await this.machines.suspend(machineId);
        } catch (error) {
          this.log(`agent ${agentId.slice(0, 12)} suspend failed, stopping: ${String(error)}`);
          await this.machines.stop(machineId);
          reached = 'stopped';
        }
      } else await this.machines.stop(machineId);
      // A suspend takes seconds to snapshot memory; `slept` marks the Machine
      // actually asleep, not the request.
      await this.machines.waitFor(machineId, reached, 60).catch(() => undefined);
      await recordFreeAgentEvent(this.database, agentId, 'slept', { machineId, state: reached });
    } catch (error) {
      this.log(`agent ${agentId.slice(0, 12)} sleep failed: ${String(error)}`);
    }
    // A wake that arrived while Fly was suspending would otherwise wait for the sweep.
    this.kick(agentId, 'sweep');
  }

  /**
   * First boot of a Machine: hand it everything it needs to stage its helper.
   * Valid until the agent first connects; each call mints a fresh daemon
   * exchange and model token, so a crashed first boot can simply retry.
   */
  async bootstrap(token: string): Promise<FreeAgentBootstrapGrant | undefined> {
    return this.database.transaction(async (database) => {
      const row = (
        await database.query<{
          agent_id: string;
          owner_id: string;
          workspace_id: string;
          workspace_name: string;
          sealed_keys: string;
          name: string;
          soul: { instructions?: string } | null;
        }>(
          `SELECT f.agent_id,f.owner_id,f.workspace_id,w.name workspace_name,f.sealed_keys,
                  i.name,a.soul
           FROM free_agents f JOIN workspaces w ON w.id=f.workspace_id
           JOIN identities i ON i.id=f.agent_id JOIN agents a ON a.agent_id=f.agent_id
           WHERE f.bootstrap_hash=$1 AND f.removed_at IS NULL AND f.state NOT IN ('failed','destroyed')
           FOR UPDATE OF f`,
          [tokenHash(token)],
        )
      ).rows[0];
      if (!row) return undefined;
      const keys = openSecrets<{ agent: string; body: string }>(this.config.sealSecret, row.sealed_keys);
      const modelToken = opaque('bfm');
      await database.query(
        `UPDATE free_agents SET model_token_hash=$2,updated_at=now() WHERE agent_id=$1`,
        [row.agent_id, tokenHash(modelToken)],
      );
      const exchange = await this.createDaemonExchange(row.agent_id, database);
      await recordFreeAgentEvent(database, row.agent_id, 'bootstrapped');
      return {
        agentId: row.agent_id,
        agentSecretKey: keys.agent,
        bodySecretKey: keys.body,
        agentName: row.name,
        harness: FREE_AGENT_HARNESS,
        model: freeAgentHarnessModel(this.config),
        soul: row.soul?.instructions ?? '',
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        pairedBy: row.owner_id,
        monolithBaseUrl: new URL(this.config.publicOrigin).origin,
        daemonExchangeToken: exchange.exchangeToken,
        modelToken,
        modelBaseUrl: `${new URL(this.config.publicOrigin).origin}/v1/free-agents/model`,
        upstreamModel: this.config.model,
        maxTurnSeconds: (this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).maxTurnMs / 1000,
        idleSeconds: this.config.idleSeconds,
      };
    });
  }

  /**
   * Leader sweep: retry provisioning, start agents with an overdue wake, put
   * forgotten running Machines to sleep, and delete Machines idle for the
   * retention window. Returns how many agents it acted on.
   */
  async sweep(): Promise<number> {
    let acted = 0;
    const removed = await this.database.query<{ agent_id: string }>(
      `SELECT agent_id FROM free_agents WHERE removed_at IS NOT NULL AND removal_cleaned_at IS NULL
       ORDER BY removed_at LIMIT 20`,
    );
    for (const row of removed.rows) {
      acted++;
      await this.cleanupRemoved(row.agent_id).catch(error =>
        this.log(`remove ${row.agent_id.slice(0, 12)}: ${String(error)}`),
      );
    }
    acted += await wakeFreeAgentsForLeaves(this.database);
    const provision = await this.database.query<{ agent_id: string }>(
      `SELECT agent_id FROM free_agents
       WHERE removed_at IS NULL AND fly_machine_id IS NULL AND state='provisioning' AND provision_attempts<5
         AND EXISTS (SELECT 1 FROM agent_commands command WHERE command.agent_id=free_agents.agent_id
           AND command.state='pending' AND (command.wake_after IS NULL OR command.wake_after<=now()))
         AND (provision_started_at IS NULL OR provision_started_at<clock_timestamp()-interval '2 minutes')
       ORDER BY created_at LIMIT 20`,
    );
    for (const row of provision.rows) {
      acted++;
      await this.provision(row.agent_id).catch((error) =>
        this.log(`provision ${row.agent_id.slice(0, 12)}: ${String(error)}`),
      );
    }
    const wakes = await this.database.query<{ agent_id: string }>(
      `SELECT f.agent_id FROM free_agents f
       WHERE (f.fly_machine_id IS NOT NULL OR f.state='destroyed') AND f.state<>'failed' AND f.removed_at IS NULL
         AND EXISTS (SELECT 1 FROM agent_commands command
           WHERE command.agent_id=f.agent_id AND command.state='pending'
             AND (command.wake_after IS NULL OR command.wake_after<=now())
             AND command.created_at<clock_timestamp()-interval '5 seconds')
         AND NOT EXISTS (SELECT 1 FROM agent_connections connection
           JOIN live_server_instances server ON server.instance_id=connection.instance_id
           WHERE connection.agent_id=f.agent_id AND connection.released_at IS NULL
             AND server.renewed_at>clock_timestamp()-interval '90 seconds'
             AND f.state='running')
       LIMIT 50`,
    );
    for (const row of wakes.rows) {
      acted++;
      await this.#advance(row.agent_id, 'sweep').catch((error) =>
        this.log(`wake ${row.agent_id.slice(0, 12)}: ${String(error)}`),
      );
    }
    // The helper's idle timer is the normal path to sleep; this catches a
    // helper that crashed or never asked, so no Machine runs unattended.
    const timedOut = await this.database.query<{ agent_id: string; fly_machine_id: string }>(
      `WITH cancelled AS (
         UPDATE agent_commands command SET state='cancelled',completed_at=clock_timestamp(),
           cancellation_reason='free-agent-time-limit'
         FROM free_agents f WHERE f.removed_at IS NULL AND command.agent_id=f.agent_id AND command.state='claimed'
           AND command.action IN ('input','resume')
           AND COALESCE((SELECT turn.started_at FROM agent_turns turn
             WHERE turn.agent_id=command.agent_id AND turn.room_id=command.room_id
               AND turn.request_id=command.turn_request_id
               AND COALESCE(turn.generation_id,'') NOT LIKE 'pending:%'),command.claimed_at)
             <clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         RETURNING command.agent_id,command.room_id,command.turn_request_id
       ), turns AS (
         UPDATE agent_turns turn SET status='cancelled',failure_reason='free-agent-time-limit'
         FROM cancelled WHERE turn.agent_id=cancelled.agent_id AND turn.room_id=cancelled.room_id
           AND turn.request_id=cancelled.turn_request_id AND turn.status='working'
       )
       UPDATE free_agents f SET state='stopped',updated_at=now()
       WHERE f.removed_at IS NULL AND f.agent_id IN (SELECT agent_id FROM cancelled) AND f.fly_machine_id IS NOT NULL
       RETURNING f.agent_id,f.fly_machine_id`,
      [(this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).maxTurnMs + 60_000],
    );
    for (const row of timedOut.rows) {
      acted++;
      await recordFreeAgentEvent(this.database, row.agent_id, 'turn_time_limit');
      await this.machines.stop(row.fly_machine_id).catch(error =>
        this.log(`stop ${row.agent_id.slice(0, 12)}: ${String(error)}`),
      );
    }
    const idle = await this.database.query<{ agent_id: string; fly_machine_id: string }>(
      `UPDATE free_agents f SET state='sleeping',updated_at=now()
       WHERE f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('running','waking')
         AND f.last_activity_at<clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         AND COALESCE(f.wake_requested_at,f.created_at)<clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         AND NOT EXISTS (SELECT 1 FROM agent_commands command
           WHERE command.agent_id=f.agent_id AND (command.state IN ('pending','claimed')
             OR (command.cancellation_reason IS DISTINCT FROM 'free-agent-time-limit'
               AND command.completed_at>clock_timestamp()-make_interval(secs => $1::double precision / 1000))))
       RETURNING f.agent_id,f.fly_machine_id`,
      [this.config.reapIdleMs],
    );
    for (const row of idle.rows) {
      acted++;
      await recordFreeAgentEvent(this.database, row.agent_id, 'reaped_idle');
      await this.machines.stop(row.fly_machine_id).catch((error) =>
        this.log(`stop ${row.agent_id.slice(0, 12)}: ${String(error)}`),
      );
    }
    const expired = await this.database.query<{ agent_id: string; fly_machine_id: string }>(
      `SELECT f.agent_id,f.fly_machine_id FROM free_agents f
       WHERE f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('sleeping','stopped')
         AND f.last_activity_at<clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         AND NOT EXISTS (SELECT 1 FROM agent_commands command
           WHERE command.agent_id=f.agent_id
             AND (command.state IN ('pending','claimed')
               OR command.created_at>clock_timestamp()-make_interval(secs => $1::double precision / 1000)))
       LIMIT 20`,
      [this.config.deleteAfterMs],
    );
    for (const row of expired.rows) {
      acted++;
      try {
        await this.machines.destroy(row.fly_machine_id);
        await this.database.query(
          `UPDATE free_agents SET fly_machine_id=NULL,state='destroyed',bootstrap_hash=NULL,
             provision_attempts=0,provision_started_at=NULL,updated_at=now()
           WHERE agent_id=$1 AND fly_machine_id=$2 AND removed_at IS NULL`,
          [row.agent_id, row.fly_machine_id],
        );
        await recordFreeAgentEvent(this.database, row.agent_id, 'deleted_idle', {
          machineId: row.fly_machine_id,
        });
      } catch (error) {
        this.log(`delete ${row.agent_id.slice(0, 12)}: ${String(error)}`);
      }
    }
    return acted;
  }

  /** Called only after removal commits; Fly failure cannot fail the Members action. */
  remove(agentId: string): void {
    void this.cleanupRemoved(agentId).catch(error =>
      this.log(`remove ${agentId.slice(0, 12)}: ${String(error)}`),
    );
  }

  /** Delete a retired agent's Machine; a failed call leaves durable work for the leader. */
  async cleanupRemoved(agentId: string): Promise<boolean> {
    const row = (await this.database.query<{ fly_machine_id: string | null; removal_cleaned_at: Date | null }>(
      `SELECT fly_machine_id,removal_cleaned_at FROM free_agents WHERE agent_id=$1 AND removed_at IS NOT NULL`,
      [agentId],
    )).rows[0];
    if (!row) return false;
    if (row.removal_cleaned_at) return true;
    const machineId = row.fly_machine_id ?? (await this.machines.find(agentId))?.id;
    if (machineId) await this.machines.destroy(machineId);
    // A create already in flight can return after this delete. Keep cleanup pending
    // through its provision lease; its completion stores the new id and retries cleanup.
    await this.database.query(
      `UPDATE free_agents SET fly_machine_id=NULL,removal_cleaned_at=CASE
         WHEN provision_started_at IS NULL OR provision_started_at<clock_timestamp()-interval '2 minutes'
         THEN clock_timestamp() ELSE NULL END,updated_at=now()
       WHERE agent_id=$1 AND removed_at IS NOT NULL AND fly_machine_id IS NOT DISTINCT FROM $2`,
      [agentId, row.fly_machine_id],
    );
    return true;
  }

  /** A committed command for any agent: start the Machine if it is a sleeping free agent. */
  kickIfFree(agentId: string): void {
    void this.database
      .query(`SELECT 1 FROM free_agents WHERE agent_id=$1 AND state<>'failed' AND removed_at IS NULL`, [agentId])
      .then((found) => {
        if (found.rowCount) this.kick(agentId, 'command');
      })
      .catch((error) => this.log(`wake lookup ${agentId.slice(0, 12)}: ${String(error)}`));
  }
}
