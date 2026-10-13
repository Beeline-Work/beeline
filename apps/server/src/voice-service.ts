import { randomBytes, randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { type VoiceCall, type VoiceJoin, type RoomViewIdentity, type VoiceProvider, voiceDuration } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { systemLine, restateSystemLine, ensureSystemIdentity } from './system-line.js';
import { routeHumanMessage } from './agent-command.js';
import { assignVoiceAgents, type VoiceAgent, type VoiceBrain, type VoiceSpeech, type VoiceSttFactory,
  OpenRouterVoiceBrain, DeepInfraKokoroSpeech, AuraSpeech, FishSpeech, fluxFactory, VOICE_MODEL } from './voice-providers.js';
import { VoiceRoomRuntime } from './voice-room-runtime.js';

export type VoiceConfig = { url: string; apiKey: string; apiSecret: string; brain: VoiceBrain;
  speech: VoiceSpeech; providers?: Partial<Record<VoiceProvider, VoiceSpeech>>; stt: VoiceSttFactory };
type CallRow = { id: string; room_id: string; message_id: string; started_at: Date; ended_at: Date | null };
type IdentityRow = { id: string; kind: 'human' | 'agent'; name: string; handle: string | null; face_id: string | null };
const identity = (row: IdentityRow): RoomViewIdentity => ({ pubkey: row.id, kind: row.kind,
  name: row.name, ...(row.handle ? { handle: row.handle } : {}), ...(row.face_id ? { face: row.face_id } : {}) });

/** The DB owns membership/session facts. LiveKit transports audio, never authority. */
export class VoiceService {
  readonly owner = randomUUID();
  private readonly runtimes = new Map<string, Promise<VoiceRoomRuntime>>();
  private readonly rooms: RoomServiceClient;
  private readonly unsubscribe: () => void;
  constructor(readonly db: SqlDatabase, readonly live: LiveHub, readonly config: VoiceConfig) {
    this.rooms = new RoomServiceClient(config.url.replace(/^ws/, 'http'), config.apiKey, config.apiSecret);
    this.unsubscribe = live.subscribeAll(event => {
      if (event.type === 'invalidate') {
        for (const runtime of this.runtimes.values()) void runtime.then(r => {
          if (r.roomId === event.roomId) return r.refresh();
        }).catch(() => {});
      }
    });
  }

  async access(roomId: string, humanId: string, db = this.db) {
    const row = (await db.query<{ id: string }>(
      `SELECT r.id FROM rooms r JOIN memberships rm ON rm.room_id=r.id AND rm.identity_id=$2 AND rm.removed_at IS NULL
       JOIN memberships wm ON wm.workspace_id=r.workspace_id AND wm.room_id IS NULL AND wm.identity_id=$2 AND wm.removed_at IS NULL
       JOIN identities i ON i.id=$2 AND i.kind='human'
       WHERE r.id=$1 AND r.archived_at IS NULL AND wm.role<>'spectator'
         AND NOT COALESCE(r.direct_participants ? $3,false) FOR SHARE OF r,rm,wm`,
      [roomId, humanId, SYSTEM_IDENTITY_ID])).rows[0];
    if (!row) throw new Error('voice call access denied');
  }

  async agents(roomId: string, humanId?: string): Promise<VoiceAgent[]> {
    const speech = await this.speech(roomId);
    const rows = await this.db.query<IdentityRow & { soul: { instructions?: string } | null;
      owner_id: string; access_policy: unknown }>(
      `SELECT i.id,i.kind,i.name,i.handle,i.face_id,a.soul,a.owner_id,a.access_policy FROM memberships m
       JOIN identities i ON i.id=m.identity_id AND i.kind='agent' JOIN agents a ON a.agent_id=i.id
       WHERE m.room_id=$1 AND m.removed_at IS NULL ORDER BY i.id`, [roomId]);
    const allowed = new Set(rows.rows.filter(a => !humanId || senderMayAddressAgent(
      parseAgentAccessPolicy(a.access_policy), humanId, a.owner_id)).map(a => a.id));
    return assignVoiceAgents(rows.rows.map(a => ({ id: a.id,
      name: a.name, handle: a.handle ?? a.name, soul: a.soul?.instructions ?? '',
      ...(a.face_id ? { face: a.face_id } : {}) })), speech.voices).filter(a => allowed.has(a.id));
  }

  async speech(roomId: string): Promise<VoiceSpeech> {
    if (!this.config.providers) return this.config.speech;
    const row = (await this.db.query<{ voice_provider: VoiceProvider }>(
      `SELECT w.voice_provider FROM workspaces w JOIN rooms r ON r.workspace_id=w.id WHERE r.id=$1`, [roomId])).rows[0];
    const speech = row && this.config.providers[row.voice_provider];
    if (!speech) throw new Error('The selected Workspace voice provider is not configured');
    await speech.prepare?.();
    return speech;
  }

  async view(row: CallRow, db = this.db): Promise<VoiceCall> {
    const members = await db.query<IdentityRow>(`SELECT i.* FROM voice_participants p JOIN identities i ON i.id=p.identity_id
      WHERE p.call_id=$1 AND p.left_at IS NULL ORDER BY p.joined_at,i.id`, [row.id]);
    return { id: row.id, roomId: row.room_id, startedAt: Math.floor(row.started_at.getTime() / 1000),
      startedAtMs: row.started_at.getTime(),
      ...(row.ended_at ? { endedAt: Math.floor(row.ended_at.getTime() / 1000) } : {}),
      participants: members.rows.map(identity) };
  }

  async current(roomId: string, humanId: string): Promise<VoiceCall | null> {
    await this.access(roomId, humanId);
    const row = (await this.db.query<CallRow>(`SELECT * FROM voice_calls WHERE room_id=$1 AND ended_at IS NULL`, [roomId])).rows[0];
    return row ? this.view(row) : null;
  }

  async join(roomId: string, humanId: string): Promise<VoiceJoin> {
    await this.access(roomId, humanId);
    const agents = await this.agents(roomId, humanId);
    if (!agents.length) throw new Error('This conversation has no agent you can address');
    const row = await this.db.transaction(async db => {
      await this.access(roomId, humanId, db);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`voice:${roomId}`]);
      let call = (await db.query<CallRow>(`SELECT * FROM voice_calls WHERE room_id=$1 AND ended_at IS NULL FOR UPDATE`, [roomId])).rows[0];
      if (!call) {
        await ensureSystemIdentity(db);
        const id = randomUUID(); const messageId = randomBytes(32).toString('hex');
        await systemLine(db, { id: messageId, roomId, authorId: SYSTEM_IDENTITY_ID,
          subject: { kind: 'system', name: 'Voice call' }, verb: 'started', presentation: 'card',
          cardType: 'voice-call', card: { id, roomId, startedAt: Math.floor(Date.now() / 1000), participants: [] } });
        call = (await db.query<CallRow>(`INSERT INTO voice_calls(id,room_id,message_id) VALUES($1,$2,$3) RETURNING *`,
          [id, roomId, messageId])).rows[0]!;
      }
      await db.query(`INSERT INTO voice_participants(call_id,identity_id) VALUES($1,$2)
        ON CONFLICT(call_id,identity_id) DO UPDATE SET left_at=NULL,joined_at=now()`, [call.id, humanId]);
      await this.updateCard(call, db);
      return call;
    });
    // Own runtime lease is cross-instance: a second phone never starts a second speaker.
    try { await this.ensureRuntime(row); }
    catch (error) { await this.leave(row.id, humanId, true); throw error; }
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, { identity: humanId,
      ttl: '10m', metadata: JSON.stringify({ callId: row.id, kind: 'human' }) });
    token.addGrant({ roomJoin: true, room: `beeline-voice-${row.id}`, canPublish: true,
      canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false });
    return { call: await this.view(row), url: this.config.url, token: await token.toJwt(),
      agents: agents.map(a => ({ pubkey: a.id, kind: 'agent', name: a.name, handle: a.handle,
        ...(a.face ? { face: a.face } : {}) })) };
  }

  async updateCard(row: CallRow, db = this.db) {
    const call = await this.view(row, db);
    await restateSystemLine(db, row.message_id, { subject: { kind: 'system', name: 'Voice call' },
      verb: row.ended_at ? 'ended' : 'started',
      ...(row.ended_at ? { consequence: voiceDuration((row.ended_at.getTime() - row.started_at.getTime()) / 1000) } : {}) },
      call as unknown as Record<string, unknown>);
    if (row.ended_at) await db.query(`UPDATE messages SET presentation=$2 WHERE id=$1`, [row.message_id, 'system']);
  }

  async leave(callId: string, humanId: string, disconnected = false): Promise<void> {
    const row = await this.db.transaction(async db => {
      const call = (await db.query<CallRow>(`SELECT * FROM voice_calls WHERE id=$1 FOR UPDATE`, [callId])).rows[0];
      if (!call || call.ended_at) return null;
      if (!disconnected) await this.access(call.room_id, humanId, db);
      await db.query(`UPDATE voice_participants SET left_at=now() WHERE call_id=$1 AND identity_id=$2`, [callId, humanId]);
      if (!(await db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND left_at IS NULL`, [callId])).rowCount) {
        call.ended_at = (await db.query<{ ended_at: Date }>(`UPDATE voice_calls SET ended_at=now() WHERE id=$1 RETURNING ended_at`, [callId])).rows[0]!.ended_at;
      }
      await this.updateCard(call, db);
      return call;
    });
    if (!row) return;
    await this.rooms.removeParticipant(`beeline-voice-${callId}`, humanId).catch(() => {});
    if (row.ended_at) {
      await this.rooms.deleteRoom(`beeline-voice-${callId}`).catch(() => {});
      const runtime = this.runtimes.get(callId);
      this.runtimes.delete(callId);
      if (runtime) await (await runtime).close();
    }
  }

  async ensureRuntime(row: CallRow) {
    if (this.runtimes.has(row.id)) return this.runtimes.get(row.id);
    const claimed = await this.db.query(`UPDATE voice_calls SET runtime_owner=$2,runtime_until=now()+interval '20 seconds'
      WHERE id=$1 AND ended_at IS NULL AND (runtime_until IS NULL OR runtime_until<now() OR runtime_owner=$2)`, [row.id, this.owner]);
    if (!claimed.rowCount) return;
    const runtime = VoiceRoomRuntime.connect(this, row.id, row.room_id).catch(async error => {
      this.runtimes.delete(row.id);
      await this.db.query(`UPDATE voice_calls SET runtime_until=NULL WHERE id=$1 AND runtime_owner=$2`, [row.id, this.owner]);
      throw error;
    });
    this.runtimes.set(row.id, runtime);
    return runtime;
  }

  /** Startup/leader reconciliation recovers active sessions after a release. */
  async recover() {
    for (const row of (await this.db.query<CallRow>(`SELECT * FROM voice_calls WHERE ended_at IS NULL`)).rows)
      await this.ensureRuntime(row).catch(() => {});
  }

  runtimeClosed(callId: string, runtime: VoiceRoomRuntime) {
    const pending = this.runtimes.get(callId);
    if (pending) void pending.then(current => {
      if (current === runtime && this.runtimes.get(callId) === pending) this.runtimes.delete(callId);
    }).catch(() => {});
  }

  async recordHuman(callId: string, roomId: string, humanId: string, agent: VoiceAgent, text: string) {
    const id = randomBytes(32).toString('hex');
    await this.db.transaction(async db => {
      await this.access(roomId, humanId, db);
      const joined = await db.query(`SELECT 1 FROM voice_participants p JOIN voice_calls c ON c.id=p.call_id
        WHERE p.call_id=$1 AND p.identity_id=$2 AND p.left_at IS NULL AND c.ended_at IS NULL FOR SHARE OF p,c`, [callId, humanId]);
      if (!joined.rowCount) throw new Error('voice call access denied');
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
        [id, roomId, humanId, `@${agent.handle} ${text.replace(/@/g, '')}`]);
    });
    return id;
  }

  async dispatch(callId: string, sourceId: string, agentId: string) {
    await this.db.transaction(async db => {
      const row = (await db.query<{ room_id: string; author_id: string; text: string }>(`SELECT m.room_id,m.author_id,m.text FROM messages m
        JOIN voice_calls c ON c.room_id=m.room_id AND c.id=$2 AND c.ended_at IS NULL WHERE m.id=$1`, [sourceId, callId])).rows[0];
      if (!row) return;
      await this.access(row.room_id, row.author_id, db);
      const target = (await db.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1 FOR SHARE`, [agentId])).rows[0];
      if (!target?.handle || !row.text.startsWith(`@${target.handle} `))
        throw new Error('The agent handle changed; please repeat the order');
      const inserted = await db.query(`INSERT INTO voice_orders(source_message_id,call_id,agent_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [sourceId, callId, agentId]);
      if (!inserted.rowCount) return;
      await routeHumanMessage(db, sourceId);
    });
  }

  async recordAnswer(roomId: string, agentId: string, text: string) {
    if (!text.trim()) return;
    await this.db.query(`INSERT INTO messages(id,room_id,author_id,text,agent_model)
      SELECT $1,$2,$3,$4,$5 FROM memberships m JOIN rooms r ON r.id=m.room_id
      WHERE m.room_id=$2 AND m.identity_id=$3 AND m.removed_at IS NULL AND r.archived_at IS NULL`,
      [randomBytes(32).toString('hex'), roomId, agentId, text, VOICE_MODEL]);
  }

  async close() {
    this.unsubscribe();
    await Promise.allSettled([...this.runtimes.values()].map(async runtime => (await runtime).close()));
    this.runtimes.clear();
  }
}

export function voiceConfigFromEnv(env = process.env): VoiceConfig | undefined {
  const key = env.BEELINE_VOICE_OPENROUTER_API_KEY || env.OPENROUTER_EMBEDDING_API_KEY;
  const cloudflareToken = env.CLOUDFLARE_WORKERS_AI_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!key || !env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET ||
      !cloudflareToken || !env.CLOUDFLARE_ACCOUNT_ID) return undefined;
  const aura = new AuraSpeech(cloudflareToken, env.CLOUDFLARE_ACCOUNT_ID);
  const kokoro = new DeepInfraKokoroSpeech(key);
  const fish = env.FISH_AUDIO_API_KEY ? new FishSpeech(env.FISH_AUDIO_API_KEY, fetch,
    env.BEELINE_VOICE_FISH_MODEL === 's2.1-pro' ? 's2.1-pro' : 's2.1-pro-free') : undefined;
  return { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET,
    brain: new OpenRouterVoiceBrain(key), speech: fish ?? aura,
    providers: { 'aura-2': aura, 'kokoro-deepinfra': kokoro, ...(fish ? { 'fish-s2.1-pro': fish } : {}) },
    stt: fluxFactory(cloudflareToken, env.CLOUDFLARE_ACCOUNT_ID) };
}
