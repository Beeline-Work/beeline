import {
  type AgentVoiceCatalog,
  type AgentVoicePreview,
  type VoiceProvider,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { assignVoiceAgents, type VoiceSpeech, VOICE_SAMPLE_RATE } from './voice-providers.js';

type Context = {
  voice_provider: VoiceProvider;
  owner_id: string;
  chosen_voices: Partial<Record<VoiceProvider, string>>;
  soul: { instructions?: string } | null;
  name: string;
  handle: string | null;
  viewer_role: string;
};
/** Configuration uses Workspace membership and owner authority, independent of a live call. */
export class AgentVoiceService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly speechFor: (provider: VoiceProvider) => Promise<VoiceSpeech>,
  ) {}
  private async context(
    workspaceId: string,
    agentId: string,
    viewerId: string,
    db = this.db,
  ): Promise<Context> {
    const row = (
      await db.query<Context>(
        `SELECT w.voice_provider,a.owner_id,a.chosen_voices,a.soul,i.name,i.handle,vm.role viewer_role
      FROM workspaces w JOIN memberships am ON am.workspace_id=w.id AND am.room_id IS NULL
        AND am.identity_id=$2 AND am.removed_at IS NULL
      JOIN agents a ON a.agent_id=am.identity_id JOIN identities i ON i.id=a.agent_id AND i.hidden_from_roster=false
      JOIN memberships vm ON vm.workspace_id=w.id AND vm.room_id IS NULL AND vm.identity_id=$3 AND vm.removed_at IS NULL
      JOIN identities v ON v.id=vm.identity_id AND v.kind='human'
      WHERE w.id=$1 FOR SHARE OF w,am,vm,a`,
        [workspaceId, agentId, viewerId],
      )
    ).rows[0];
    if (!row) throw Error('Workspace agent access denied');
    return row;
  }
  private async library(provider: VoiceProvider) {
    const speech = await this.speechFor(provider);
    await speech.prepare?.();
    const choices: AgentVoiceCatalog['choices'] =
      speech.choices ??
      (speech.voices ?? []).map((id) => ({
        id,
        name: id.replace(/^[ab][fm]_/, '').replace(/_/g, ' '),
      }));
    if (!choices.length) throw Error('The Workspace voice provider has no available voices');
    return { speech, choices };
  }
  async catalog(
    workspaceId: string,
    agentId: string,
    viewerId: string,
    roomId?: string,
  ): Promise<AgentVoiceCatalog> {
    const ctx = await this.context(workspaceId, agentId, viewerId);
    const { choices } = await this.library(ctx.voice_provider);
    const speakers = roomId
      ? (
          await this.db.query<{
            id: string;
            name: string;
            handle: string | null;
            soul: { instructions?: string } | null;
            chosen_voices: Context['chosen_voices'];
          }>(
            `SELECT i.id,i.name,i.handle,a.soul,a.chosen_voices FROM memberships m
       JOIN identities i ON i.id=m.identity_id AND i.kind='agent' JOIN agents a ON a.agent_id=i.id
       JOIN rooms r ON r.id=m.room_id AND r.workspace_id=$2 AND r.archived_at IS NULL
       WHERE m.room_id=$1 AND m.removed_at IS NULL AND EXISTS (
         SELECT 1 FROM memberships vm WHERE vm.room_id=r.id AND vm.identity_id=$3 AND vm.removed_at IS NULL)`,
            [roomId, workspaceId, viewerId],
          )
        ).rows.map((a) => ({
          id: a.id,
          name: a.name,
          handle: a.handle ?? a.name,
          soul: a.soul?.instructions ?? '',
          chosenVoice: a.chosen_voices[ctx.voice_provider],
        }))
      : [
          {
            id: agentId,
            name: ctx.name,
            handle: ctx.handle ?? ctx.name,
            soul: ctx.soul?.instructions ?? '',
            chosenVoice: ctx.chosen_voices[ctx.voice_provider],
          },
        ];
    const current = assignVoiceAgents(
      speakers,
      choices.map((v) => v.id),
    ).find((v) => v.id === agentId);
    if (!current) throw Error('Room agent access denied');
    return {
      provider: ctx.voice_provider,
      currentVoiceId: current.voice,
      canChange: ctx.owner_id === viewerId && ctx.viewer_role !== 'spectator',
      choices,
    };
  }
  async save(
    workspaceId: string,
    agentId: string,
    viewerId: string,
    provider: VoiceProvider,
    voiceId: string,
  ): Promise<AgentVoiceCatalog> {
    const ctx = await this.context(workspaceId, agentId, viewerId);
    if (ctx.owner_id !== viewerId || ctx.viewer_role === 'spectator')
      throw Error('Only the agent owner can change its voice');
    if (provider !== ctx.voice_provider)
      throw Error('The Workspace voice provider changed. Reopen the picker.');
    const { choices } = await this.library(provider);
    if (!choices.some((v) => v.id === voiceId))
      throw Error('Unknown voice in the Workspace provider library');
    await this.db.transaction(async (db) => {
      // Global provider fence covers agents belonging to several Workspaces and concurrent saves.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-voice:${provider}`]);
      const current = await this.context(workspaceId, agentId, viewerId, db);
      if (
        current.owner_id !== viewerId ||
        current.viewer_role === 'spectator' ||
        current.voice_provider !== provider
      )
        throw Error('Agent ownership or Workspace voice provider changed');
      const conflict = (
        await db.query(
          `SELECT 1 FROM agents other
        WHERE other.agent_id<>$1 AND other.chosen_voices->>$2=$3 AND EXISTS (
          SELECT 1 FROM memberships own JOIN memberships peer ON peer.room_id=own.room_id
          JOIN rooms r ON r.id=own.room_id AND r.archived_at IS NULL
          WHERE own.identity_id=$1 AND peer.identity_id=other.agent_id
            AND own.removed_at IS NULL AND peer.removed_at IS NULL) LIMIT 1`,
          [agentId, provider, voiceId],
        )
      ).rowCount;
      if (conflict)
        throw Error('Another agent in this Room has chosen that voice. Choose a different voice.');
      await db.query(
        `UPDATE agents SET chosen_voices=jsonb_set(chosen_voices,ARRAY[$2::text],to_jsonb($3::text)),updated_at=now() WHERE agent_id=$1`,
        [agentId, provider, voiceId],
      );
    });
    return this.catalog(workspaceId, agentId, viewerId);
  }
  async preview(
    workspaceId: string,
    agentId: string,
    viewerId: string,
    provider: VoiceProvider,
    voiceId: string,
  ): Promise<AgentVoicePreview> {
    const ctx = await this.context(workspaceId, agentId, viewerId);
    if (provider !== ctx.voice_provider)
      throw Error('The Workspace voice provider changed. Reopen the picker.');
    const { speech, choices } = await this.library(provider);
    const choice = choices.find((v) => v.id === voiceId);
    if (!choice) throw Error('Unknown voice in the Workspace provider library');
    if (choice.sampleUrl) return { url: choice.sampleUrl };
    // Existing PCM synthesis, capped at eight seconds; no key or arbitrary URL reaches the phone.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const chunks: Buffer[] = [];
    let length = 0;
    const cap = VOICE_SAMPLE_RATE * 2 * 8;
    try {
      for await (const chunk of speech.synthesize(
        'Hello. This is my voice. I am ready to help you.',
        voiceId,
        controller.signal,
      )) {
        const part = Buffer.from(chunk).subarray(0, cap - length);
        chunks.push(part);
        length += part.length;
        if (length >= cap) {
          controller.abort();
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (!length) throw Error('Voice preview unavailable');
    const pcm = Buffer.concat(chunks).subarray(0, length - (length % 2));
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(VOICE_SAMPLE_RATE, 24);
    header.writeUInt32LE(VOICE_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return { wavBase64: Buffer.concat([header, pcm]).toString('base64') };
  }
}
