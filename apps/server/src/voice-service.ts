import { prepareCornerCompatibility } from './corner-person-state.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { VoiceBudgetStore } from './voice-budget.js';
import { AgentVoiceService } from './agent-voice.js';
import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { type VoiceIdleState, type VoiceCall, type VoiceJoin, type RoomViewIdentity, voiceDuration } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { systemLine, restateSystemLine, ensureSystemIdentity } from './system-line.js';
import { searchInstitutionalHistory } from './institutional-history.js';
import { routeHumanMessage } from './agent-command.js';
import { assignVoiceAgents, type VoiceAgent, type VoiceBrain, type VoiceSearch, type VoiceSpeech, type VoiceSttFactory,
  OpenRouterVoiceBrain, openRouterWebSearch, AuraSpeech, fluxFactory, VOICE_MODEL, AURA_VOICES, savedAuraVoice } from './voice-providers.js';
import { VoiceRoomRuntime } from './voice-room-runtime.js';
import type { SpeechMember } from './markdown-to-speech.js';

export type VoiceConfig = { url: string; apiKey: string; apiSecret: string; brain: VoiceBrain;
  speech: VoiceSpeech; stt: VoiceSttFactory; searchWeb?: (query: string, signal: AbortSignal) => Promise<string>; budgetLimitMs?: number };
type CallRow = { id: string; room_id: string; message_id: string; started_at: Date; ended_at: Date | null; end_reason?: string | null };
type IdentityRow = { id: string; kind: 'human' | 'agent'; name: string; handle: string | null; face_id: string | null };
const identity = (row: IdentityRow): RoomViewIdentity => ({ pubkey: row.id, kind: row.kind,
  name: row.name, ...(row.handle ? { handle: row.handle } : {}), ...(row.face_id ? { face: row.face_id } : {}) });

/** The DB owns membership/session facts. LiveKit transports audio, never authority. */
export class VoiceService {
  readonly owner = randomUUID();
  readonly profiles: AgentVoiceService;
  readonly budget: VoiceBudgetStore;
  private readonly runtimes = new Map<string, Promise<VoiceRoomRuntime | undefined>>();
  private readonly rooms: RoomServiceClient;
  private readonly unsubscribe: () => void;
  constructor(readonly db: SqlDatabase, readonly live: LiveHub, readonly config: VoiceConfig) {
    this.db = new CornerAccessDatabase(db);
    this.budget = new VoiceBudgetStore(db, config.budgetLimitMs);
    this.profiles = new AgentVoiceService(db, () => this.speech());
    this.rooms = new RoomServiceClient(config.url.replace(/^ws/, 'http'), config.apiKey, config.apiSecret);
    this.unsubscribe = live.subscribeAll(event => {
      if (event.type === 'invalidate') {
        for (const runtime of this.runtimes.values()) void runtime.then(r => {
          if (r?.roomId === event.roomId) return Promise.all([r.countHumans(), r.refresh()]);
        }).catch(() => {});
      }
    });
  }

  async access(roomId: string, humanId: string, db = this.db) {
    const row = (await db.query<{ id: string }>(
      `SELECT r.id FROM rooms r JOIN memberships rm ON rm.room_id=COALESCE(r.parent_id,r.id) AND rm.identity_id=$2 AND rm.removed_at IS NULL
       JOIN memberships wm ON wm.workspace_id=r.workspace_id AND wm.room_id IS NULL AND wm.identity_id=$2 AND wm.removed_at IS NULL
       JOIN identities i ON i.id=$2 AND i.kind='human'
       WHERE r.id=$1 AND r.archived_at IS NULL AND wm.role<>'spectator'
         AND NOT COALESCE(r.direct_participants ? $3,false) FOR SHARE OF r,rm,wm`,
      [roomId, humanId, SYSTEM_IDENTITY_ID])).rows[0];
    if (!row) throw new Error('voice call access denied');
  }

  async workspaceId(roomId: string, db = this.db): Promise<string> {
    const row = (await db.query<{ workspace_id: string }>('SELECT workspace_id FROM rooms WHERE id=$1', [roomId])).rows[0];
    if (!row) throw new Error('voice room missing');
    return row.workspace_id;
  }

  async endWorkspaceCalls(workspaceId: string) {
    const calls = await this.db.transaction(async db => {
      // Serialize workspace endings, and recheck the day after acquiring it.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`voice-budget:${workspaceId}`]);
      if ((await this.budget.read(workspaceId, db)).remainingMs > 0) return [];
      const calls = await db.query<CallRow>(`SELECT c.* FROM voice_calls c
        JOIN rooms r ON r.id=c.room_id WHERE r.workspace_id=$1 AND c.ended_at IS NULL FOR UPDATE OF c`, [workspaceId]);
      for (const call of calls.rows) {
        const ended = (await db.query<CallRow>(`UPDATE voice_calls SET ended_at=now(),end_reason=$2
          WHERE id=$1 RETURNING *`, [call.id, "Today's 60 minutes are used"])).rows[0]!;
        await db.query('UPDATE voice_participants SET left_at=now() WHERE call_id=$1 AND left_at IS NULL', [call.id]);
        await this.updateCard(ended, db);
      }
      return calls.rows;
    });
    // Use the same RTC/runtime cleanup as an ordinary call ending. Commit the
    // reason first, so a client's concurrent leave cannot erase it.
    await Promise.all(calls.map(call => this.finishEndedCall(call.id)));
  }

  async agents(roomId: string, humanId?: string): Promise<VoiceAgent[]> {
    const speech = await this.speech(roomId);
    const rows = await this.db.query<
      IdentityRow & {
        soul: { instructions?: string } | null;
        owner_id: string;
        access_policy: unknown;
        chosen_voices: Record<string, string>;
      }
    >(
      `SELECT i.id,i.kind,i.name,i.handle,i.face_id,a.soul,a.owner_id,a.access_policy,a.chosen_voices FROM memberships m
       JOIN identities i ON i.id=m.identity_id AND i.kind='agent' JOIN agents a ON a.agent_id=i.id
       JOIN rooms r ON r.id=m.room_id JOIN workspaces w ON w.id=r.workspace_id
       WHERE m.room_id=$1 AND m.removed_at IS NULL ORDER BY i.id`,
      [roomId],
    );
    const allowed = new Set(
      rows.rows
        .filter(
          (a) =>
            !humanId ||
            senderMayAddressAgent(parseAgentAccessPolicy(a.access_policy), humanId, a.owner_id),
        )
        .map((a) => a.id),
    );
    return assignVoiceAgents(
      rows.rows.map((a) => ({
        id: a.id,
        name: a.name,
        handle: a.handle ?? a.name,
        soul: a.soul?.instructions ?? '',
        chosenVoice: savedAuraVoice(a.chosen_voices),
        ...(a.face_id ? { face: a.face_id } : {}),
      })),
      speech.voices,
    ).filter((a) => allowed.has(a.id));
  }

  /** Handle-to-display-name pairs for every current Room member, for spoken names. */
  async memberNames(roomId: string): Promise<SpeechMember[]> {
    const rows = await this.db.query<IdentityRow>(
      `SELECT i.id,i.kind,i.name,i.handle,i.face_id FROM memberships m
       JOIN identities i ON i.id=m.identity_id WHERE m.room_id=$1 AND m.removed_at IS NULL`,
      [roomId],
    );
    return rows.rows.map(row => ({ handle: row.handle ?? row.name, name: row.name }));
  }

  /** Only current, addressable agents' committed messages in this exact Room/corner count. */
  async lastActiveAgent(roomId: string, agents: readonly VoiceAgent[]): Promise<string | undefined> {
    if (!agents.length) return undefined;
    const result = await this.db.query<{ author_id: string }>(
      `SELECT author_id FROM messages WHERE room_id=$1 AND author_id=ANY($2::text[])
       AND presentation='message' AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1`,
      [roomId, agents.map(agent => agent.id)]);
    return result.rows[0]?.author_id;
  }

  async speech(_roomId?: string): Promise<VoiceSpeech> {
    const speech = this.config.speech;
    if (!speech) throw new Error('Aura 2 is not configured');
    await speech.prepare?.();
    return speech;
  }

  async humanCount(callId: string): Promise<number> {
    const result = await this.db.query<{ count: number }>(`SELECT count(*)::int count FROM voice_participants p
      JOIN identities i ON i.id=p.identity_id AND i.kind='human'
      WHERE p.call_id=$1 AND p.left_at IS NULL`, [callId]);
    return result.rows[0]?.count ?? 0;
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

  async join(roomId: string, humanId: string, expectedCallId?: string): Promise<VoiceJoin> {
    await this.access(roomId, humanId);
    await this.budget.require(await this.workspaceId(roomId));
    const agents = await this.agents(roomId, humanId);
    if (!agents.length) throw new Error('This conversation has no agent you can address');
    const sessionId = randomUUID();
    const row = await this.db.transaction(async db => {
      await this.access(roomId, humanId, db);
      const workspaceId = await this.workspaceId(roomId, db);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`voice-budget:${workspaceId}`]);
      await this.budget.require(workspaceId, db);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`voice:${roomId}`]);
      let call = (await db.query<CallRow>(`SELECT * FROM voice_calls WHERE room_id=$1 AND ended_at IS NULL FOR UPDATE`, [roomId])).rows[0];
      if (expectedCallId && call?.id !== expectedCallId) throw new Error('voice session ended');
      if (!call) {
        await ensureSystemIdentity(db);
        const id = randomUUID(); const messageId = randomBytes(32).toString('hex');
        await systemLine(db, { id: messageId, roomId, authorId: SYSTEM_IDENTITY_ID,
          subject: { kind: 'system', name: 'Voice call' }, verb: 'started', presentation: 'card',
          cardType: 'voice-call', card: { id, roomId, startedAt: Math.floor(Date.now() / 1000), participants: [] } });
        call = (await db.query<CallRow>(`INSERT INTO voice_calls(id,room_id,message_id) VALUES($1,$2,$3) RETURNING *`,
          [id, roomId, messageId])).rows[0]!;
      }
      await db.query(`INSERT INTO voice_participants(call_id,identity_id,session_id) VALUES($1,$2,$3)
        ON CONFLICT(call_id,identity_id) DO UPDATE SET left_at=NULL,parked_at=NULL,joined_at=now(),session_id=excluded.session_id`, [call.id, humanId, sessionId]);
      await this.updateCard(call, db);
      return call;
    });
    // Own runtime lease is cross-instance: a second phone never starts a second speaker.
    try { await this.ensureRuntime(row); }
    catch (error) { await this.leave(row.id, humanId, true, sessionId); throw error; }
    await (await this.runtimes.get(row.id))?.countHumans().catch(() => {});
    this.live.publish({ type: 'invalidate', roomId, reason: 'voice-participants' });
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, { identity: humanId,
      ttl: '10m', metadata: JSON.stringify({ callId: row.id, kind: 'human' }) });
    token.addGrant({ roomJoin: true, room: `beeline-voice-${row.id}`, canPublish: true,
      canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false });
    return { sessionId, stopToken: this.stopToken(row.id, humanId, sessionId), call: await this.view(row), url: this.config.url, token: await token.toJwt(),
      agents: agents.map(a => ({ pubkey: a.id, kind: 'agent', name: a.name, handle: a.handle,
        ...(a.face ? { face: a.face } : {}) })) };
  }

  /** Compatibility for older phones: idle never parks or removes a human. */
  async idleState(callId: string, humanId: string, db = this.db, sessionId?: string): Promise<VoiceIdleState> {
    const participant = (await db.query<{ room_id: string }>(`SELECT c.room_id FROM voice_calls c
      JOIN voice_participants p ON p.call_id=c.id AND p.identity_id=$2 AND p.left_at IS NULL
      WHERE c.id=$1 AND c.ended_at IS NULL AND ($3::text IS NULL OR p.session_id=$3)`, [callId, humanId, sessionId ?? null])).rows[0];
    if (!participant) return { state: 'ended' };
    await this.access(participant.room_id, humanId, db);
    return { state: 'ready' };
  }

  async idle(callId: string, humanId: string, sessionId?: string): Promise<VoiceIdleState> {
    return this.idleState(callId, humanId, this.db, sessionId);
  }

  async callWorkState(callId: string, db = this.db): Promise<{ pending: boolean; finishedAt: number }> {
    const row = (await db.query<{ pending: boolean; finished_at: Date | null }>(`SELECT
      coalesce(bool_or(c.state IN ('pending','claimed')),false) pending, max(c.completed_at) finished_at
      FROM voice_orders o JOIN agent_commands c
      ON c.source_message_id=o.source_message_id AND c.agent_id=o.agent_id WHERE o.call_id=$1`, [callId])).rows[0];
    return { pending: row?.pending ?? false, finishedAt: row?.finished_at?.getTime() ?? 0 };
  }

  async hasCallWork(callId: string, db = this.db): Promise<boolean> {
    return (await this.callWorkState(callId, db)).pending;
  }

  /** Only the current runtime owner may end the whole inactive call. */
  async endInactive(callId: string, owner: string, stillInactive: () => boolean): Promise<boolean> {
    const inactivity = { owner, stillInactive, ended: false };
    await this.leave(callId, '', true, undefined, inactivity);
    return inactivity.ended;
  }

  async resume(callId: string, humanId: string, sessionId: string): Promise<void> {
    const participant = (await this.db.query<{ room_id: string }>(`SELECT c.room_id FROM voice_calls c
      JOIN voice_participants p ON p.call_id=c.id WHERE c.id=$1 AND p.identity_id=$2
      AND p.session_id=$3 AND p.left_at IS NULL AND c.ended_at IS NULL`, [callId, humanId, sessionId])).rows[0];
    if (!participant) throw new Error('voice session ended');
    await this.access(participant.room_id, humanId);
    await this.budget.require(await this.workspaceId(participant.room_id));
    await this.db.query(`UPDATE voice_participants SET parked_at=NULL WHERE call_id=$1 AND identity_id=$2
      AND session_id=$3 AND left_at IS NULL`, [callId, humanId, sessionId]);
    const call = (await this.db.query<CallRow>(`SELECT * FROM voice_calls WHERE id=$1 AND ended_at IS NULL`, [callId])).rows[0];
    if (!call) throw new Error('voice session ended');
    const runtime = await this.ensureRuntime(call);
    await runtime?.resume(humanId);
  }

  private stopToken(callId: string, humanId: string, sessionId: string): string {
    const payload = Buffer.from(JSON.stringify({ callId, humanId, sessionId, expires: Date.now() + 86_400_000 })).toString('base64url');
    const signature = createHmac('sha256', this.config.apiSecret).update(`voice-stop:${payload}`).digest('base64url');
    return `${payload}.${signature}`;
  }

  /** This capability grants only leave for the exact session, never Room access. */
  async nativeStop(callId: string, token: unknown): Promise<boolean> {
    if (typeof token !== 'string' || token.length > 1024) return false;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return false;
    const expected = createHmac('sha256', this.config.apiSecret).update(`voice-stop:${payload}`).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
    let value: { callId: string; humanId: string; sessionId: string; expires: number };
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return false; }
    if (value.callId !== callId || typeof value.humanId !== 'string' || typeof value.sessionId !== 'string'
      || !Number.isFinite(value.expires) || value.expires <= Date.now()) return false;
    await this.leave(callId, value.humanId, true, value.sessionId);
    return true;
  }

  async updateCard(row: CallRow, db = this.db) {
    const call = await this.view(row, db);
    await restateSystemLine(db, row.message_id, { subject: { kind: 'system', name: row.end_reason && row.end_reason !== 'silence' ? 'Call' : 'Voice call' },
      verb: row.ended_at ? 'ended' : 'started',
      ...(row.ended_at ? { consequence: voiceDuration((row.ended_at.getTime() - row.started_at.getTime()) / 1000) + (row.end_reason === 'silence' ? ' · No one spoke for 60s' : row.end_reason ? ` · ${row.end_reason}` : '') } : {}) },
      call as unknown as Record<string, unknown>);
    if (row.ended_at) await db.query(`UPDATE messages SET presentation=$2,created_at=$3 WHERE id=$1`, [row.message_id, 'system', row.ended_at]);
  }

  async leave(callId: string, humanId: string, disconnected = false, sessionId?: string, inactivity?: { owner: string; stillInactive(): boolean; ended: boolean }): Promise<void> {
    const resumed = new Error('Voice activity resumed');
    const row = await this.db.transaction(async db => {
      const call = (await db.query<CallRow>(`SELECT * FROM voice_calls WHERE id=$1 FOR UPDATE`, [callId])).rows[0];
      if (!call || call.ended_at) return null;
      if (inactivity) {
        const owned = await db.query(`SELECT 1 FROM voice_calls WHERE id=$1 AND runtime_owner=$2 AND runtime_until>now()`, [callId, inactivity.owner]);
        if (!owned.rowCount || await this.hasCallWork(callId, db) || !inactivity.stillInactive()) return null;
        await db.query(`UPDATE voice_participants SET left_at=now(),parked_at=NULL WHERE call_id=$1 AND left_at IS NULL`, [callId]);
      } else {
        if (!disconnected) await this.access(call.room_id, humanId, db);
        const left = await db.query(`UPDATE voice_participants SET left_at=now() WHERE call_id=$1 AND identity_id=$2
          AND ($3::text IS NULL OR session_id=$3) RETURNING identity_id`, [callId, humanId, sessionId ?? null]);
        if (!left.rowCount) return null;
        await this.rooms.removeParticipant(`beeline-voice-${callId}`, humanId).catch(() => {});
      }
      if (!(await db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND left_at IS NULL`, [callId])).rowCount) {
        call.end_reason = inactivity ? 'silence' : null;
        call.ended_at = (await db.query<{ ended_at: Date }>(`UPDATE voice_calls SET ended_at=now(),end_reason=$2 WHERE id=$1 RETURNING ended_at`, [callId, inactivity ? 'silence' : null])).rows[0]!.ended_at;
      }
      await this.updateCard(call, db);
      if (inactivity && !inactivity.stillInactive()) throw resumed;
      return call;
    }).catch(error => { if (error === resumed) return null; throw error; });
    if (!row) return;
    (await this.runtimes.get(callId))?.participantLeft?.(humanId);
    if (row.ended_at && inactivity) { inactivity.ended = true; await (await this.runtimes.get(callId))?.stopCall(); }
    await (await this.runtimes.get(callId))?.countHumans().catch(() => {});
    this.live.publish({ type: 'invalidate', roomId: row.room_id, reason: 'voice-participants' });
    if (row.ended_at) await this.finishEndedCall(callId);
  }

  private async finishEndedCall(callId: string) {
    await this.rooms.deleteRoom(`beeline-voice-${callId}`).catch(() => {});
    const runtime = this.runtimes.get(callId);
    this.runtimes.delete(callId);
    if (runtime) await (await runtime)?.close();
  }

  ensureRuntime(row: CallRow): Promise<VoiceRoomRuntime | undefined> {
    const existing = this.runtimes.get(row.id);
    if (existing) return existing.then(runtime => {
      if (!runtime?.isClosed) return runtime;
      if (this.runtimes.get(row.id) === existing) this.runtimes.delete(row.id);
      return this.ensureRuntime(row);
    });
    // Reserve the promise before the first database await. A lease belongs to
    // this runtime attempt, so a stale close cannot release a successor's lease.
    const leaseOwner = `${this.owner}:${randomUUID()}`;
    const pending = (async () => {
      const claimed = await this.db.query(`UPDATE voice_calls SET runtime_owner=$2,runtime_until=now()+interval '20 seconds'
        WHERE id=$1 AND ended_at IS NULL AND (runtime_until IS NULL OR runtime_until<now())
        AND EXISTS(SELECT 1 FROM voice_participants p WHERE p.call_id=voice_calls.id AND p.left_at IS NULL)`, [row.id, leaseOwner]);
      if (!claimed.rowCount) return undefined;
      return VoiceRoomRuntime.connect(this, row.id, row.room_id, leaseOwner);
    })().catch(async error => {
      await this.db.query(`UPDATE voice_calls SET runtime_until=NULL WHERE id=$1 AND runtime_owner=$2`, [row.id, leaseOwner]);
      throw error;
    });
    this.runtimes.set(row.id, pending);
    void pending.then(runtime => {
      if (!runtime && this.runtimes.get(row.id) === pending) this.runtimes.delete(row.id);
    }, () => {
      if (this.runtimes.get(row.id) === pending) this.runtimes.delete(row.id);
    });
    return pending;
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

  async recordHuman(callId: string, roomId: string, humanId: string, agent: VoiceAgent, text: string, leaseOwner?: string, requestId?: string) {
    const id = requestId ?? randomBytes(32).toString('hex');
    await this.db.transaction(async db => {
      await this.access(roomId, humanId, db);
      const joined = await db.query(`SELECT 1 FROM voice_participants p JOIN voice_calls c ON c.id=p.call_id
        WHERE p.call_id=$1 AND p.identity_id=$2 AND p.left_at IS NULL AND c.ended_at IS NULL AND ($3::text IS NULL OR (c.runtime_owner=$3 AND c.runtime_until>now())) FOR SHARE OF p,c`, [callId, humanId, leaseOwner ?? null]);
      if (!joined.rowCount) throw new Error('voice call access denied');
      await db.query(`WITH message AS (INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id)
        INSERT INTO voice_messages(message_id,call_id) SELECT id,$5 FROM message`,
        [id, roomId, humanId, `@${agent.handle} ${text.replace(/@/g, '')}`, callId]);
    });
    this.live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: id, operation: 'INSERT' });
    return id;
  }

  async reviseHuman(callId: string, roomId: string, humanId: string, agent: VoiceAgent,
    sourceId: string, text: string, leaseOwner: string) {
    await this.db.transaction(async db => {
      await this.access(roomId, humanId, db);
      const joined = await db.query(`SELECT 1 FROM voice_participants p JOIN voice_calls c ON c.id=p.call_id
        WHERE p.call_id=$1 AND c.room_id=$2 AND p.identity_id=$3 AND p.left_at IS NULL AND c.ended_at IS NULL
          AND c.runtime_owner=$4 AND c.runtime_until>now() FOR SHARE OF p,c`, [callId, roomId, humanId, leaseOwner]);
      if (!joined.rowCount) throw new Error('voice call access denied');
      const existing = (await db.query<{text: string}>(`SELECT text FROM messages
        WHERE id=$1 AND room_id=$2 AND author_id=$3 AND presentation='message' AND deleted_at IS NULL FOR UPDATE`,
        [sourceId, roomId, humanId])).rows[0];
      if (!existing) throw new Error('voice call access denied');
      if (existing.text === `@${agent.handle} ${text.replace(/@/g, '')}`) return;
      const committed = (await db.query<{agent_id: string}>(`SELECT agent_id FROM voice_orders WHERE source_message_id=$1`, [sourceId])).rows[0];
      if (committed && committed.agent_id !== agent.id) throw new Error('A delivered voice request retains its agent');
      const changed = await db.query(`UPDATE messages m SET text=$5
        FROM voice_calls c, voice_participants p
        WHERE m.id=$1 AND m.room_id=$2 AND m.author_id=$3 AND m.deleted_at IS NULL
          AND c.id=$4 AND c.room_id=m.room_id AND c.ended_at IS NULL
          AND c.runtime_owner=$6 AND c.runtime_until>now()
          AND p.call_id=c.id AND p.identity_id=m.author_id AND p.left_at IS NULL
          AND m.presentation='message'`,
        [sourceId, roomId, humanId, callId, `@${agent.handle} ${text.replace(/@/g, '')}`, leaseOwner]);
      if (!changed.rowCount) throw new Error('voice call access denied');
      // The message lock serializes dispatch, claim replacement and transcript edits.
      // Keep one durable command. Claimed/completed attempts lose their old request
      // authority before the revised request becomes runnable.
      const commands = await db.query<{id: string; state: string; turn_request_id: string; result_message_id: string | null}>(
        `SELECT c.id,c.state,c.turn_request_id,c.result_message_id FROM agent_commands c
         JOIN voice_orders o ON o.source_message_id=c.source_message_id AND o.agent_id=c.agent_id
         WHERE c.source_message_id=$1 AND o.call_id=$2 FOR UPDATE OF c`, [sourceId, callId]);
      for (const command of commands.rows) {
        if (command.state === 'pending') {
          await db.query(`UPDATE agent_commands SET reason='voice_amendment' WHERE id=$1`, [command.id]);
          continue;
        }
        await db.query(`UPDATE agent_turns SET status='cancelled',failure_reason='Voice request amended'
          WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`, [roomId, agent.id, command.turn_request_id]);
        if (command.result_message_id) await db.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`, [command.result_message_id]);
        await db.query(`UPDATE agent_commands SET state='pending',reason='voice_amendment',
          turn_request_id=$2,generation_id=NULL,lease_expires_at=NULL,claimed_at=NULL,completed_at=NULL,result_message_id=NULL
          WHERE id=$1`, [command.id, randomBytes(32).toString('hex')]);
        await db.query(`UPDATE voice_orders SET spoken_message_id=NULL WHERE source_message_id=$1`, [sourceId]);
      }
    });
    this.live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: sourceId, operation: 'UPDATE' });
  }

  async search(callId: string, sourceId: string, agentId: string, request: VoiceSearch, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    const source = (await this.db.query<{ room_id: string; author_id: string }>(
      `SELECT m.room_id,m.author_id FROM messages m JOIN voice_calls c ON c.room_id=m.room_id
       JOIN voice_participants p ON p.call_id=c.id AND p.identity_id=m.author_id
       WHERE c.id=$1 AND m.id=$2 AND c.ended_at IS NULL AND p.left_at IS NULL`, [callId, sourceId])).rows[0];
    if (!source) throw new Error('Voice request is no longer available');
    await this.access(source.room_id, source.author_id);
    if (!(await this.agents(source.room_id, source.author_id)).some(agent => agent.id === agentId))
      throw new Error('Voice agent is no longer available');
    if (signal.aborted) throw signal.reason;
    if (request.name === 'search_history') {
      return JSON.stringify(await searchInstitutionalHistory(this.db, {
        room_id: source.room_id, root_source_message_id: sourceId, agent_id: agentId, turn_request_id: sourceId,
      }, { roomId: source.room_id, agentId, query: request.query, limit: 3 }));
    }
    if (!this.config.searchWeb) throw new Error('Voice web search is unavailable');
    return this.config.searchWeb(request.query, signal);
  }

  async dispatch(callId: string, sourceId: string, agentId: string) {
    await this.db.transaction(async db => {
      const row = (await db.query<{ room_id: string; author_id: string; text: string }>(`SELECT m.room_id,m.author_id,m.text FROM messages m
        JOIN voice_calls c ON c.room_id=m.room_id AND c.id=$2 AND c.ended_at IS NULL
        JOIN voice_participants p ON p.call_id=c.id AND p.identity_id=m.author_id AND p.left_at IS NULL
        WHERE m.id=$1 FOR UPDATE OF m FOR SHARE OF c,p`, [sourceId, callId])).rows[0];
      if (!row) throw new Error('Voice request is no longer available');
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
    text=text.trim();
    // Luna can render the same complete answer twice, formatted then plain.
    // Collapse only identical whole renditions separated by a paragraph break;
    // repetitions within a sentence and different paragraphs remain intact.
    const rendition = (value: string) => value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\s+/g, ' ').trim();
    for (const boundary of text.matchAll(/\n\s*\n/g)) {
      const first = text.slice(0, boundary.index).trim();
      const second = text.slice(boundary.index! + boundary[0].length).trim();
      if (first && rendition(first) === rendition(second)) { text = first; break; }
    }
    if (!text.trim()) return;
    await this.db.transaction(async database => {
      const physical = await prepareCornerCompatibility(database, roomId, agentId);
      await (async function(this: { db: SqlDatabase }) {
    await this.db.query(`INSERT INTO messages(id,room_id,author_id,text,agent_model)
      SELECT $1,$2,$3,$4,$5 FROM memberships m JOIN rooms r ON r.id=m.room_id
      WHERE m.room_id=$2 AND m.identity_id=$3 AND m.removed_at IS NULL AND r.archived_at IS NULL`,
      [randomBytes(32).toString('hex'), roomId, agentId, text, VOICE_MODEL]);
      }).call({ db: physical });
    });
  }

  async close() {
    this.unsubscribe();
    await Promise.allSettled([...this.runtimes.values()].map(async runtime => (await runtime)?.close()));
    this.runtimes.clear();
  }
}

export function voiceConfigFromEnv(env = process.env): VoiceConfig | undefined {
  const key = env.BEELINE_VOICE_OPENROUTER_API_KEY || env.OPENROUTER_EMBEDDING_API_KEY;
  const cloudflareToken = env.CLOUDFLARE_WORKERS_AI_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!key || !env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET ||
      !cloudflareToken || !env.CLOUDFLARE_ACCOUNT_ID) return undefined;
  const aura = new AuraSpeech(cloudflareToken, env.CLOUDFLARE_ACCOUNT_ID);
  return { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET,
    brain: new OpenRouterVoiceBrain(key), searchWeb: openRouterWebSearch(key), speech: aura,
    stt: fluxFactory(cloudflareToken, env.CLOUDFLARE_ACCOUNT_ID) };
}
