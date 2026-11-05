import { setRoomEventSubscriptions } from './agent-subscriptions.js';
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from 'node:crypto';
import { assignSeededAgentIdentity, resolveFace, uniqueAgentHandle } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { freeAgentDailyTokenCapFromEnv, freeAgentFirstDayTokenCapFromEnv, freeAgentLimitsFromEnv, type FreeAgentLimits } from './free-agent-limits.js';
import { createInvitedWorkspaceMembership, joinRooms } from './membership-join.js';
import { lockIdentityHandleWorkspaces } from './workspace-handles.js';
import { FreeAgentService } from './free-agents-free-agent-service.js';



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
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS starter_role text;
DROP TRIGGER IF EXISTS defer_allowance_wake ON agent_commands;
DROP FUNCTION IF EXISTS defer_allowance_wake();
-- Inert for the previous server during this rolling release; drop next release.
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS allowance_paused_until timestamptz;
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

export const FREE_AGENT_HARNESS = 'pi';


export interface FreeAgentConfig {
  limits?: FreeAgentLimits;
  /** Upstream OpenRouter model every proxied request is pinned to. */
  model: string;
  lunaModel?: string;
  /** Seconds without work before the helper asks to sleep. */
  idleSeconds: number;
  /** Free agents one person may own; later Workspaces get none. */
  maxPerOwner: number;
  dailyTokenCap: number;
  /** Larger allowance during an owner's first 24 hours; always at least `dailyTokenCap`. */
  firstDayTokenCap: number;
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
  const sealSecret = env.BEELINE_FREE_AGENT_SEAL_KEY;
  const image = env.FLY_FREE_AGENT_IMAGE;
  if (!sealSecret || !image) return undefined;
  const number = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    limits: freeAgentLimitsFromEnv(env),
    model: env.BEELINE_FREE_AGENT_MODEL || 'deepseek/deepseek-v4.1-flash-1017',
    lunaModel: env.BEELINE_FREE_AGENT_LUNA_MODEL || 'openai/gpt-6-luna',
    idleSeconds: number('BEELINE_FREE_AGENT_IDLE_SECONDS', 60),
    maxPerOwner: number('BEELINE_FREE_AGENT_MAX_PER_OWNER', 3),
    dailyTokenCap: freeAgentDailyTokenCapFromEnv(env),
    firstDayTokenCap: freeAgentFirstDayTokenCapFromEnv(env),
    lifetimeTokenCap: number('BEELINE_FREE_AGENT_LIFETIME_TOKENS', 0),
    sealSecret,
    publicOrigin: env.BEELINE_FREE_AGENT_SERVER_ORIGIN || publicOrigin,
    image,
    region: env.FLY_FREE_AGENT_REGION || 'iad',
    cpus: number('FLY_FREE_AGENT_CPUS', 1),
    memoryMb: number('FLY_FREE_AGENT_MEMORY_MB', 2048),
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


export function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}


export function sealKey(secret: string): Buffer {
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


/** Owner-approved backfill greeting (approval relayed by Ruby, ae9a4279). */
export const LUNA_BACKFILL_HELLO =
  "Hi {name}, I'm Luna. I just joined your team. Beebee and I run on different AI models, so we can check each other's work. What should we do first?";

export const LUNA_BACKFILL_HELLO_APPROVED = true;


export const FREE_AGENT_HELLO =
  `@<owner> Hi, I'm Beebee, your free agent. I run on my own small cloud computer, so I can research, write, draft, build things and run code for you.

Three things to know:
- **Talk to me here.** Tag @beebee, or just type while I'm the only agent in this Room.
- **Big jobs get a corner.** That's where I plan, do and check the work, then bring you one thing to approve. Tap it to follow along.
- **Connect once, use everywhere.** Link your apps in Connectors and every agent here can use them. You can also add your own agents, like Claude Code or Codex, from Members.

What are you working on? Tell me, and I'll take the first step with you. If you'd rather not have me here, remove me from Members.`;


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


export const FREE_AGENT_APP_CONNECT_GUIDE = `For Grok/xAI, Muse/Meta AI, ChatGPT, Claude or Cursor, use connect for Beeline Rooms steps: in that assistant add https://join.usebeeline.app as a custom connector, sign in to Beeline, tap Allow, then Room Members > + to add the new member. No custom-connector option means it cannot connect yet; Muse's directory listing is pending. TikTok sign-in awaits TikTok's approval of Beeline; never claim it works or offer sign-in. For apps needing Trusty Squire, call connect to offer its card once; Squire runs on your hosted machine too: have them tap the card and finish sign-in on their phone. Do not require their own computer. Follow connect's next; never loop through Settings > Connectors.`;


export const FREE_AGENT_REPOSITORY_GUIDE = `When the person picks "Something else", ask what job they want in their own words. Post the repository card only when the person asks for coding work on a codebase (writing, fixing or reviewing code in a repo), or asks to connect GitHub or a repository. For non-coding requests, never suggest linking a repository; do the requested research, writing, drafting or other work directly. For example, "help me write a cold email" needs no repository card; "fix the login bug in my app" needs the repository card if this Room has no repository. On those coding or connection requests, call app_tool(app:"beeline:onboarding", tool:"repository", args:{}). For other repository work, discover the repository and starters tools with app_tool(app:"beeline:onboarding"). If the card fails, explain the actual reason and the concrete next step to connect the repository. For coding work when a Room has no repository, post its repository card instead of sending anyone to Settings or a CLI. When a person wants to switch repositories, post the same card. After linking, offer the starters card, grounded in recent commits, CI and open issues. A tapped starter is an instruction to start that task now: open a repository corner with a complete brief using their selection as approval, do the work, and use the normal checks, independent review and merge path.`;


export const FREE_AGENT_TURN_GUIDE = `Before long work, call read(facet:"usage") to check your remaining allowance. If the job will not fit, deliver a smaller useful version or explain the limit up front. End every turn with the deliverable or a clear status explaining what is finished, what stopped, and the next step. Never end on a promise of more work: once your turn ends, no work continues until another message wakes you.`;


export const FREE_AGENT_YOUTUBE_GUIDE = `When the person picks "Make a welcome video and post it to my YouTube", the server starts the welcome-video workflow. Read its pinned contract and continue that run; never start another. Make the personalized vertical 9:16 film yourself using free tiers, with Squire for signups. Never ask the person to supply the clip. Connect YouTube first if needed. Use outcome blocked promptly when Squire or another required capability is unavailable so the next agent can try. Stay inside your free-agent allowance. An independent agent checks the film before its preview. Before showing video_preview, discover the connected YouTube tools and call YOUTUBE_LIST_CHANNELS with mine:true. If there are zero channels, tell the person to create a YouTube channel at youtube.com and stop; after they create it, check again before showing a Post card. Check that the clip is square or vertical and within YouTube Shorts duration limits. Draft a title and description, ask Luna for one second opinion, and name Luna's concrete catch. Extract a frame from the clip and post it as an image artifact in this Room. Then call app_tool(app:"beeline:onboarding",tool:"video_preview",args:{videoObjectId,frameObjectId,title,description,visibility:"public"}) to show the frame with the exact metadata above Post/Cancel. Honor a person's explicit visibility choice; use unlisted for an unlisted test. Do not upload or schedule anything until the person taps Post on that preview. Discover the connected app's current tools. Upload with YOUTUBE_MULTIPART_UPLOAD_VIDEO, never YOUTUBE_UPLOAD_VIDEO. Use exactly videoFile: {beelineObjectId: "<videoObjectId from the preview>"}, with the approved title, description and privacyStatus; do not use name/mimetype/s3key or a local path. A clear YouTube refusal leaves the same Post tap valid: after the person fixes the cause, retry the exact approved upload without another preview or tap. If an upload times out or its outcome is uncertain, check YouTube for the video before retrying; never risk a duplicate upload. Confirm YouTube's fileDetails.fileSize matches the clip bytes and processingDetails.processingStatus is succeeded before calling it posted; an id alone is not success. Verify public visibility and share the Short URL. If processing is pending, report that state and the concrete next step. Never claim a video was posted when it was not.`;


export const FREE_AGENT_TEAM_GUIDE = `You are on a team with another free starter agent. If you are Beebee, for the person's first three substantive questions in this Room, ask another agent in the Room for one second opinion before your final answer, if another agent is present. After those first three questions, ask only when in doubt. Say in your final answer what changed and who caught it. Count substantive questions from the conversation, excluding greetings, game moves and onboarding choices. One review round per answer. If another agent asks you for a second opinion, reply once, tagging the requesting agent once to deliver your opinion, and never ask back or request another review. Use the other agent's exact current handle from the Room roster. Credit them by plain name in the final answer; do not tag them again. After the first helpful answer, offer to invite a friend. When the person wants an invite to their own Room, call app_tool(app:"beeline:onboarding",tool:"invite",args:{}); it prints the invite link in this chat. Never open a share sheet.`;


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

${FREE_AGENT_TURN_GUIDE}

${FREE_AGENT_CONNECT_GUIDE}

${FREE_AGENT_APP_CONNECT_GUIDE}`;
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
  input: { workspaceId: string; creatorId: string; roomId: string; name?: 'Beebee' | 'Luna'; silent?: boolean; team?: boolean },
): Promise<string | undefined> {
  const owned = await database.query<{ count: number }>(
    `SELECT count(*)::int count FROM free_agents WHERE owner_id=$1`,
    [input.creatorId],
  );
  if ((owned.rows[0]?.count ?? 0) >= config.maxPerOwner) return undefined;
  const name = input.name ?? 'Beebee';
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
    name,
    roster.rows.flatMap((row) => (row.handle ? [row.handle] : [])),
  );
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,face_id) VALUES($1,'agent',$2,$3,$4)`,
    [agent.publicKey, name, handle, seeded.face],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,soul,selected_model,machine_id,machine_name,harness)
     VALUES($1,$2,$3::jsonb,$4,$5,'Beeline cloud',$6)`,
    [
      agent.publicKey,
      input.creatorId,
      JSON.stringify({
        name,
        instructions: freeAgentInstructions(seeded.soul, name, config) + (input.team ? `\n\n${FREE_AGENT_TEAM_GUIDE}\n\n${FREE_AGENT_YOUTUBE_GUIDE}` : ''),
        avatarSeed: agent.publicKey,
      }),
      freeAgentHarnessModel(config),
      `free-agent:${agent.publicKey}`,
      FREE_AGENT_HARNESS,
    ],
  );
  await createInvitedWorkspaceMembership(database, [input.workspaceId, agent.publicKey, input.creatorId]);
  await database.query(
    `INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,model,starter_role)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      agent.publicKey,
      input.workspaceId,
      input.creatorId,
      sealSecrets(config.sealSecret, { agent: agent.secretKey, body: body.secretKey }),
      config.model,
      input.team ? name.toLowerCase() : null,
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
  if (!input.team) await setRoomEventSubscriptions(database, input.roomId, agent.publicKey, FREE_AGENT_EVENT_SUBSCRIPTIONS);
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
  const hello = FREE_AGENT_HELLO.replace('<owner>', owner.handle).replace('<handle>', handle);
  const helloId = createHash('sha256').update(`free-agent-hello:${agent.publicKey}`).digest('hex');
  // An ordinary agent-authored message: the existing mention/push path notifies the owner.
  if (!input.silent) await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
    [helloId, input.roomId, agent.publicKey, hello],
  );
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


/**
 * Starts without a connection that stop the restarts: a Machine that boots but
 * never connects would otherwise be started every 20 seconds forever.
 */
export const FREE_AGENT_START_LIMIT = 5;

export const FREE_AGENT_START_WINDOW_MINUTES = 10;


/** Durable install/sign-in work ends on completion, failure, or disconnect. */
export const connectorWorkSql = (agent: string): string => `(
  EXISTS (SELECT 1 FROM agents helper WHERE helper.agent_id=${agent}
    AND helper.squire_work->>'install'='true'
    AND COALESCE(helper.squire_work->>'errorMessage','')='')
  OR EXISTS (SELECT 1 FROM workspace_connectors connector
    WHERE connector.helper_agent_id=${agent} AND connector.status='installing')
)`;


/**
 * Whether a wake is due for the row `f`: pending work, a Machine, and the
 * agent not serving. A waking or running agent waits 20 seconds between starts.
 */
export const WAKE_DUE_SQL = `f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL
  AND (f.state IN ('sleeping','stopped')
    OR (f.state IN ('waking','running')
      AND (f.wake_requested_at IS NULL OR f.wake_requested_at<clock_timestamp()-interval '20 seconds')
      AND NOT EXISTS (SELECT 1 FROM agent_connections connection
        JOIN live_server_instances server ON server.instance_id=connection.instance_id
        WHERE connection.agent_id=f.agent_id AND connection.released_at IS NULL
          AND server.renewed_at>clock_timestamp()-interval '90 seconds')))
  AND (${connectorWorkSql('f.agent_id')} OR EXISTS (SELECT 1 FROM agent_commands command
    WHERE command.agent_id=f.agent_id AND command.state='pending'))`;


/**
 * The start limit for one agent. A `connected` event ends an episode. A
 * `start_limit_reached` event stops starts until a person sends a new message
 * that queues a command; that message opens a fresh episode. Join, leave and
 * other System lines carry a human author but never clear the stop.
 */
export const START_LIMIT_SQL = `WITH last_connect AS (
    SELECT max(at) at FROM free_agent_events WHERE agent_id=$1 AND kind='connected'),
  last_stop AS (
    SELECT max(at) at FROM free_agent_events WHERE agent_id=$1 AND kind='start_limit_reached')
  SELECT
    (last_stop.at IS NOT NULL AND (last_connect.at IS NULL OR last_stop.at>last_connect.at)
      AND NOT EXISTS (SELECT 1 FROM agent_commands command
        JOIN messages source ON source.id=command.source_message_id
          AND source.presentation='message' AND source.system_event IS NULL
        JOIN identities author ON author.id=source.author_id AND author.kind='human'
        WHERE command.agent_id=$1 AND command.state='pending' AND command.created_at>last_stop.at)) stopped,
    (SELECT count(*)::int FROM free_agent_events started
      WHERE started.agent_id=$1 AND started.kind='wake_requested'
        AND started.at>GREATEST(clock_timestamp()-make_interval(mins => $2), last_connect.at, last_stop.at)) starts
  FROM last_connect, last_stop`;


/** Wake reasons recorded for the latency measurement. */
export type WakeCause = 'command' | 'connector' | 'sweep' | 'provisioned';
export { FreeAgentService } from './free-agents-free-agent-service.js';
