import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { closeFreeAgentTurn } from './free-agent-turn-close.js';
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from 'node:crypto';
import { assignSeededAgentIdentity, resolveFace, uniqueAgentHandle } from '@beeline/api-contract/phone';
import { createAgentCommand } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import type { FreeAgentMachines } from './fly-machines.js';
import type { LiveHub } from './live.js';
import { DEFAULT_FREE_AGENT_LIMITS, freeAgentDailyTokenCapFromEnv, freeAgentFirstDayTokenCapFromEnv, freeAgentBudgetReached, freeAgentLimitsFromEnv, type FreeAgentLimits } from './free-agent-limits.js';
import { joinRooms } from './membership-join.js';
import { captureServerError } from './sentry.js';
import { systemLine } from './system-line.js';
import { lockIdentityHandleWorkspaces } from './workspace-handles.js';
import { createStarterOnboardingRun } from './starter-onboarding-run.js';

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
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS allowance_paused_until timestamptz;
CREATE OR REPLACE FUNCTION defer_allowance_wake() RETURNS trigger LANGUAGE plpgsql AS $pause$
BEGIN
  IF NEW.state='pending' AND NEW.action IN ('input','resume') THEN
    NEW.startup_wake_after := GREATEST(NEW.startup_wake_after,
      (SELECT allowance_paused_until FROM free_agents WHERE agent_id=NEW.agent_id AND allowance_paused_until>now()));
  END IF;
  RETURN NEW;
END $pause$;
DROP TRIGGER IF EXISTS defer_allowance_wake ON agent_commands;
CREATE TRIGGER defer_allowance_wake BEFORE INSERT OR UPDATE OF state ON agent_commands
  FOR EACH ROW EXECUTE FUNCTION defer_allowance_wake();
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

export const FREE_AGENT_APP_CONNECT_GUIDE = `For Grok/xAI, Muse/Meta AI, ChatGPT, Claude or Cursor, use connect for Beeline Rooms steps: in that assistant add https://server.usebeeline.app/mcp as a custom connector, sign in to Beeline, tap Allow, then Room Members > + to add the new member. No custom-connector option means it cannot connect yet; Muse's directory listing is pending. TikTok sign-in awaits TikTok's approval of Beeline; never claim it works or offer sign-in. For apps needing Trusty Squire, call connect to offer its card once; Squire runs on your hosted machine too: have them tap the card and finish sign-in on their phone. Do not require their own computer. Follow connect's next; never loop through Settings > Connectors.`;

export const FREE_AGENT_REPOSITORY_GUIDE = `When the person picks "Something else", ask what job they want in their own words. Post the repository card only when the person asks for coding work on a codebase (writing, fixing or reviewing code in a repo), or asks to connect GitHub or a repository. For non-coding requests, never suggest linking a repository; do the requested research, writing, drafting or other work directly. For example, "help me write a cold email" needs no repository card; "fix the login bug in my app" needs the repository card if this Room has no repository. On those coding or connection requests, call app_tool(app:"beeline:onboarding", tool:"repository", args:{}). For other repository work, discover the repository and starters tools with app_tool(app:"beeline:onboarding"). If the card fails, explain the actual reason and the concrete next step to connect the repository. For coding work when a Room has no repository, post its repository card instead of sending anyone to Settings or a CLI. When a person wants to switch repositories, post the same card. After linking, offer the starters card, grounded in recent commits, CI and open issues. A tapped starter is an instruction to start that task now: open a repository corner with a complete brief using their selection as approval, do the work, and use the normal checks, independent review and merge path.`;

export const FREE_AGENT_TURN_GUIDE = `Before long work, call read(facet:"usage") to check your remaining allowance. If the job will not fit, deliver a smaller useful version or explain the limit up front. End every turn with the deliverable or a clear status explaining what is finished, what stopped, and the next step. Never end on a promise of more work: once your turn ends, no work continues until another message wakes you.`;

const FREE_AGENT_YOUTUBE_GUIDE = `When the person picks "Make a welcome video and post it to my YouTube", the server starts the welcome-video workflow. Read its pinned contract and continue that run; never start another. Make the personalized vertical 9:16 film yourself using free tiers, with Squire for signups. Never ask the person to supply the clip. Connect YouTube first if needed. Use outcome blocked promptly when Squire or another required capability is unavailable so the next agent can try. Stay inside your free-agent allowance. An independent agent checks the film before its preview. Before showing video_preview, discover the connected YouTube tools and call YOUTUBE_LIST_CHANNELS with mine:true. If there are zero channels, tell the person to create a YouTube channel at youtube.com and stop; after they create it, check again before showing a Post card. Check that the clip is square or vertical and within YouTube Shorts duration limits. Draft a title and description, ask Luna for one second opinion, and name Luna's concrete catch. Extract a frame from the clip and post it as an image artifact in this Room. Then call app_tool(app:"beeline:onboarding",tool:"video_preview",args:{videoObjectId,frameObjectId,title,description,visibility:"public"}) to show the frame with the exact metadata above Post/Cancel. Honor a person's explicit visibility choice; use unlisted for an unlisted test. Do not upload or schedule anything until the person taps Post on that preview. Discover the connected app's current tools. Upload with YOUTUBE_MULTIPART_UPLOAD_VIDEO, never YOUTUBE_UPLOAD_VIDEO. Use exactly videoFile: {beelineObjectId: "<videoObjectId from the preview>"}, with the approved title, description and privacyStatus; do not use name/mimetype/s3key or a local path. A clear YouTube refusal leaves the same Post tap valid: after the person fixes the cause, retry the exact approved upload without another preview or tap. If an upload times out or its outcome is uncertain, check YouTube for the video before retrying; never risk a duplicate upload. Confirm YouTube's fileDetails.fileSize matches the clip bytes and processingDetails.processingStatus is succeeded before calling it posted; an id alone is not success. Verify public visibility and share the Short URL. If processing is pending, report that state and the concrete next step. Never claim a video was posted when it was not.`;

const FREE_AGENT_TEAM_GUIDE = `You are on a team with another free starter agent. If you are Beebee, for the person's first three substantive questions in this Room, ask another agent in the Room for one second opinion before your final answer, if another agent is present. After those first three questions, ask only when in doubt. Say in your final answer what changed and who caught it. Count substantive questions from the conversation, excluding greetings, game moves and onboarding choices. One review round per answer. If another agent asks you for a second opinion, reply once, tagging the requesting agent once to deliver your opinion, and never ask back or request another review. Use the other agent's exact current handle from the Room roster. Credit them by plain name in the final answer; do not tag them again. After the first helpful answer, offer to invite a friend. When the person wants an invite to their own Room, call app_tool(app:"beeline:onboarding",tool:"invite",args:{}); it prints the invite link in this chat. Never open a share sheet.`;

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
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
     VALUES($1,NULL,$2,'member',$3)`,
    [input.workspaceId, agent.publicKey, input.creatorId],
  );
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
  if (!input.team) await database.query(
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

/**
 * A member leaving or being removed from a Room already writes its System
 * line; a free agent subscribed to `left` there gets one wake on that line.
 * The leader runs this on every committed message, so the note follows the
 * leave within moments. Returns how many wakes it queued.
 */
async function wakeFreeAgentsForLeaves(database: SqlDatabase): Promise<number> {
  const leaves = await database.query<{ message_id: string; room_id: string; agent_id: string }>(
    `SELECT line.id message_id,subscriber.room_id,subscriber.identity_id agent_id
     FROM room_access subscriber
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

/**
 * Starts without a connection that stop the restarts: a Machine that boots but
 * never connects would otherwise be started every 20 seconds forever.
 */
export const FREE_AGENT_START_LIMIT = 5;
export const FREE_AGENT_START_WINDOW_MINUTES = 10;

/** Durable install/sign-in work ends on completion, failure, or disconnect. */
const connectorWorkSql = (agent: string): string => `(
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
const WAKE_DUE_SQL = `f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL
  AND (f.state IN ('sleeping','stopped')
    OR (f.state IN ('waking','running')
      AND (f.wake_requested_at IS NULL OR f.wake_requested_at<clock_timestamp()-interval '20 seconds')
      AND NOT EXISTS (SELECT 1 FROM agent_connections connection
        JOIN live_server_instances server ON server.instance_id=connection.instance_id
        WHERE connection.agent_id=f.agent_id AND connection.released_at IS NULL
          AND server.renewed_at>clock_timestamp()-interval '90 seconds')))
  AND (${connectorWorkSql('f.agent_id')} OR EXISTS (SELECT 1 FROM agent_commands command
    WHERE command.agent_id=f.agent_id AND command.state='pending'
             AND (command.startup_wake_after IS NULL OR command.startup_wake_after<=now())
      AND (command.wake_after IS NULL OR command.wake_after<=now())))`;

/**
 * The start limit for one agent. A `connected` event ends an episode. A
 * `start_limit_reached` event stops starts until a person sends a new message
 * that queues a command; that message opens a fresh episode. Join, leave and
 * other System lines carry a human author but never clear the stop.
 */
const START_LIMIT_SQL = `WITH last_connect AS (
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
type WakeCause = 'command' | 'connector' | 'sweep' | 'provisioned';

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

  async createInWorkspace(
    database: SqlDatabase,
    input: { workspaceId: string; creatorId: string; roomId: string; team?: boolean; timeZone?: string },
  ): Promise<string | undefined> {
    // Serialize owner creation so simultaneous Workspaces cannot exceed the cap.
    await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`free-agent-create:${input.creatorId}`]);
    if (!input.team) return createFreeAgentInWorkspace(database, this.config, input);
    const owned = (await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM free_agents WHERE owner_id=$1`, [input.creatorId],
    )).rows[0]?.count ?? 0;
    if (owned + 2 > this.config.maxPerOwner) return undefined;
    const beebee = await createFreeAgentInWorkspace(database, this.config, { ...input, silent: true, team: true });
    const luna = await createFreeAgentInWorkspace(database, {
      ...this.config, model: this.config.lunaModel ?? 'openai/gpt-6-luna',
    }, { ...input, name: 'Luna', silent: true, team: true });
    if (!beebee || !luna) throw new Error('starter team provisioning failed');
    await database.query(`UPDATE memberships SET event_subscriptions=$3::jsonb
      WHERE identity_id=ANY($1::text[]) AND room_id=$2 AND removed_at IS NULL`,
      [[beebee, luna], input.roomId, JSON.stringify(FREE_AGENT_EVENT_SUBSCRIPTIONS)]);
    await createStarterOnboardingRun(database, { roomId: input.roomId, userId: input.creatorId, beebeeId: beebee, lunaId: luna, timeZone: input.timeZone });
    return beebee;
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
    if ((await this.database.query(`SELECT 1 FROM free_agents WHERE agent_id=$1 AND allowance_paused_until>now()`, [agentId])).rowCount) return true;
    if (!await freeAgentBudgetReached(this.database, (this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).dailyBudgetUsd)) return false;
    await recordFreeAgentEvent(this.database, agentId, 'budget_reached');
    return true;
  }

  async wake(agentId: string, cause: WakeCause = 'command'): Promise<boolean> {
    if (await this.#budgetPaused(agentId)) return false;
    const decision = await this.database.transaction(async (db) => {
      // The row lock is the fence: one instance decides each start or stop.
      await db.query(`SELECT 1 FROM free_agents WHERE agent_id=$1 FOR UPDATE`, [agentId]);
      const due = (
        await db.query<{ fly_machine_id: string; previous: string }>(
          `SELECT f.fly_machine_id,f.state previous FROM free_agents f WHERE f.agent_id=$1 AND ${WAKE_DUE_SQL}`,
          [agentId],
        )
      ).rows[0];
      if (!due) return undefined;
      const limit = (
        await db.query<{ stopped: boolean; starts: number }>(START_LIMIT_SQL, [
          agentId,
          FREE_AGENT_START_WINDOW_MINUTES,
        ])
      ).rows[0]!;
      if (limit.stopped) return undefined;
      if (limit.starts >= FREE_AGENT_START_LIMIT) {
        await this.#stopStarts(db, agentId, due.fly_machine_id, limit.starts);
        return { kind: 'stopped' as const, machineId: due.fly_machine_id, starts: limit.starts };
      }
      await db.query(
        `UPDATE free_agents SET state='waking',wake_requested_at=clock_timestamp(),
           last_activity_at=now(),updated_at=now() WHERE agent_id=$1`,
        [agentId],
      );
      await recordFreeAgentEvent(db, agentId, 'wake_requested', { cause, previous: due.previous });
      return { kind: 'claimed' as const, claimed: due };
    });
    if (!decision) return false;
    if (decision.kind === 'stopped') {
      this.log(`agent ${agentId.slice(0, 12)} never connected after ${decision.starts} starts; stopped starting`);
      captureServerError(
        new Error(`Free agent Machine never connected after ${decision.starts} starts in ${FREE_AGENT_START_WINDOW_MINUTES} minutes`),
        { area: 'free-agent-start-limit', agentId, machineId: decision.machineId, starts: String(decision.starts) },
      );
      await this.machines.stop(decision.machineId).catch((error) =>
        this.log(`stop ${agentId.slice(0, 12)}: ${String(error)}`),
      );
      return false;
    }
    const claimed = decision.claimed;
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
   * Record the stop and tell the person whose message is waiting, in the Room
   * of the newest pending command. The notice id follows the stop event, so a
   * retry writes nothing twice.
   */
  async #stopStarts(db: SqlDatabase, agentId: string, machineId: string, starts: number): Promise<void> {
    await db.query(`UPDATE free_agents SET state='stopped',updated_at=now() WHERE agent_id=$1`, [agentId]);
    const event = (
      await db.query<{ id: string }>(
        `INSERT INTO free_agent_events(agent_id,kind,detail) VALUES($1,'start_limit_reached',$2::jsonb) RETURNING id`,
        [agentId, JSON.stringify({ machineId, starts })],
      )
    ).rows[0]!;
    const target = (
      await db.query<{ room_id: string; agent_name: string; person_id: string | null; person_handle: string | null }>(
        `SELECT command.room_id,agent.name agent_name,person.id person_id,person.handle person_handle
         FROM agent_commands command
         JOIN identities agent ON agent.id=command.agent_id
         JOIN free_agents f ON f.agent_id=command.agent_id
         LEFT JOIN messages source ON source.id=command.source_message_id
         LEFT JOIN identities author ON author.id=source.author_id AND author.kind='human'
         LEFT JOIN identities person ON person.id=COALESCE(author.id,f.owner_id)
         WHERE command.agent_id=$1 AND command.state='pending'
         ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
        [agentId],
      )
    ).rows[0];
    if (!target) return;
    await systemLine(db, {
      roomId: target.room_id,
      id: createHash('sha256').update(`free-agent-start-limit:${event.id}`).digest('hex'),
      subject: { kind: 'agent', id: agentId, name: target.agent_name },
      verb: systemMessage("free-agents.could-not-start"),
      ...(target.person_id && target.person_handle
        ? { object: { text: systemMessage("free-agents.for", target.person_handle), id: target.person_id } }
        : {}),
      consequence: systemMessage("free-agents.the-beeline-team-has-been-told-send-a-new-message-to-try-again"),
    });
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
           AND NOT ${connectorWorkSql('f.agent_id')}
           AND NOT EXISTS (SELECT 1 FROM agent_commands command
             WHERE command.agent_id=f.agent_id AND command.state IN ('pending','claimed')
               AND (command.state='claimed' OR ((command.wake_after IS NULL OR command.wake_after<=now()) AND (command.startup_wake_after IS NULL OR command.startup_wake_after<=now()))))
         RETURNING f.fly_machine_id`,
        [agentId],
      )
    ).rows[0];
    if (!slept) return { sleep: false };
    // A helper behind the announced release stops instead, so its next boot
    // installs the new release; a suspended Machine would resume the old one.
    const mode = options.refresh ? 'stop' : 'suspend';
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
          model: string | null;
        }>(
          `SELECT f.agent_id,f.owner_id,f.workspace_id,w.name workspace_name,f.sealed_keys,
                  i.name,a.soul,f.model
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
        model: freeAgentHarnessModel({ model: row.model ?? this.config.model }),
        soul: row.soul?.instructions ?? '',
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        pairedBy: row.owner_id,
        monolithBaseUrl: new URL(this.config.publicOrigin).origin,
        daemonExchangeToken: exchange.exchangeToken,
        modelToken,
        modelBaseUrl: `${new URL(this.config.publicOrigin).origin}/v1/free-agents/model`,
        upstreamModel: row.model ?? this.config.model,
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
         AND (${connectorWorkSql('free_agents.agent_id')} OR EXISTS (SELECT 1 FROM agent_commands command WHERE command.agent_id=free_agents.agent_id
           AND command.state='pending' AND (command.startup_wake_after IS NULL OR command.startup_wake_after<=now()) AND (command.wake_after IS NULL OR command.wake_after<=now())))
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
         AND (${connectorWorkSql('f.agent_id')} OR EXISTS (SELECT 1 FROM agent_commands command
           WHERE command.agent_id=f.agent_id AND command.state='pending'
             AND (command.startup_wake_after IS NULL OR command.startup_wake_after<=now())
             AND (command.wake_after IS NULL OR command.wake_after<=now())
             AND command.created_at<clock_timestamp()-interval '5 seconds'))
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
    const timedOut = await this.database.query<{
      id: string; agent_id: string; room_id: string; turn_request_id: string; generation_id: string | null;
    }>(`SELECT command.id,command.agent_id,command.room_id,command.turn_request_id,command.generation_id
       FROM agent_commands command JOIN free_agents f ON f.agent_id=command.agent_id
       WHERE f.removed_at IS NULL AND command.state='claimed' AND command.action IN ('input','resume')
         AND COALESCE((SELECT turn.started_at FROM agent_turns turn
           WHERE turn.agent_id=command.agent_id AND turn.room_id=command.room_id
             AND turn.request_id=command.turn_request_id
             AND COALESCE(turn.generation_id,'') NOT LIKE 'pending:%'),command.claimed_at)
           <clock_timestamp()-make_interval(secs => $1::double precision / 1000)
       ORDER BY command.claimed_at LIMIT 100`,
      [(this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).maxTurnMs + 60_000]);
    for (const row of timedOut.rows) {
      const stopped = await this.database.transaction(async db => {
        // Use the same lock order as terminal receipts before changing the command.
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,
          [`silence:${row.room_id}:${row.turn_request_id}:${row.agent_id}`]);
        const cancelled = await db.query(`UPDATE agent_commands SET state='cancelled',
          completed_at=clock_timestamp(),cancellation_reason='free-agent-time-limit'
          WHERE id=$1 AND state='claimed' AND generation_id IS NOT DISTINCT FROM $2`, [row.id,row.generation_id]);
        if (!cancelled.rowCount) return null;
        await db.query(`UPDATE agent_turns SET status='cancelled',failure_reason='free-agent-time-limit'
          WHERE agent_id=$1 AND room_id=$2 AND request_id=$3 AND status='working'`,
          [row.agent_id,row.room_id,row.turn_request_id]);
        const machine = (await db.query<{ fly_machine_id: string | null }>(
          `UPDATE free_agents SET state='stopped',updated_at=now()
           WHERE agent_id=$1 AND removed_at IS NULL RETURNING fly_machine_id`, [row.agent_id])).rows[0];
        await closeFreeAgentTurn(db, { roomId: row.room_id, requestId: row.turn_request_id,
          agentId: row.agent_id, reason: 'free-agent-time-limit' });
        await recordFreeAgentEvent(db, row.agent_id, 'turn_time_limit');
        return machine;
      });
      if (!stopped) continue;
      acted++;
      if (stopped.fly_machine_id) await this.machines.stop(stopped.fly_machine_id).catch(error =>
        this.log(`stop ${row.agent_id.slice(0, 12)}: ${String(error)}`));
    }
    const idle = await this.database.query<{ agent_id: string; fly_machine_id: string }>(
      `UPDATE free_agents f SET state='sleeping',updated_at=now()
       WHERE f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('running','waking')
         AND f.last_activity_at<clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         AND COALESCE(f.wake_requested_at,f.created_at)<clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         AND NOT ${connectorWorkSql('f.agent_id')}
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
         AND NOT ${connectorWorkSql('f.agent_id')}
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

  /** Committed work wakes the Machine; the sweep recovers missed notifications. */
  subscribeToWakes(live: LiveHub): () => void {
    return live.subscribeAll((event) => {
      if (event.type !== 'invalidate' || !event.targetAgentId) return;
      if (event.reason === 'connector-assignment') this.kickIfFree(event.targetAgentId, 'connector');
      else if (event.reason === 'postgres:agent_commands' && event.operation === 'INSERT')
        this.kickIfFree(event.targetAgentId);
    });
  }

  /** Start the Machine if committed work targets a free agent. */
  kickIfFree(agentId: string, cause: WakeCause = 'command'): void {
    void this.database
      .query(`SELECT 1 FROM free_agents f WHERE agent_id=$1 AND state<>'failed' AND removed_at IS NULL
        ${cause === 'connector' ? `AND ${connectorWorkSql('f.agent_id')}` : ''}`, [agentId])
      .then((found) => {
        if (found.rowCount) this.kick(agentId, cause);
      })
      .catch((error) => this.log(`wake lookup ${agentId.slice(0, 12)}: ${String(error)}`));
  }
}
