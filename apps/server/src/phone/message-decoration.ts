import { composioToolkitForApp } from '../composio-apps.js';
import type { RoomViewIdentity, RoomViewMessage } from '@beeline/api-contract/phone';
import type { PhoneContext } from './context.js';
import { UUID_PATTERN } from './values.js';
import { IdentityRow } from './types.js';
import { identity, assetUrl } from './read-projection.js';
import { phoneOptionalEnrichment } from './optional-enrichment.js';
import { phoneReadAppCatalog } from './workbench-catalog.js';



  /** Project the end cause without changing the stored System card or its wording. */
  export async function phoneDecorateVoiceCallReasons(ctx: PhoneContext, roomId: string, messages: RoomViewMessage[]): Promise<RoomViewMessage[]> {
    const ids = messages.flatMap(message => message.voiceCall?.endedAt ? [message.voiceCall.id] : []);
    if (!ids.length) return messages;
    const rows = await ctx.database.query<{ id: string; end_reason: string | null }>(
      `SELECT id,end_reason FROM voice_calls WHERE room_id=$1 AND id=ANY($2::uuid[]) AND ended_at IS NOT NULL`, [roomId, ids], 'phone-room-card-voice-0');
    const silent = new Set(rows.rows.filter(row => row.end_reason === 'silence').map(row => row.id));
    return messages.map(message => message.voiceCall && silent.has(message.voiceCall.id)
      ? { ...message, voiceCall: { ...message.voiceCall, endReason: 'silence' as const } } : message);
  }


  export async function phoneDecorateApprovalSources(ctx: PhoneContext, messages: RoomViewMessage[]): Promise<RoomViewMessage[]> {
    const ids = [...new Set(messages.flatMap(message => {
      const card = message.grantRequest ?? message.squireApproval;
      return card?.sourceMessageId ? [card.sourceMessageId] : [];
    }))];
    if (!ids.length) return messages;
    const rows = await ctx.database.query<{ id: string; room_id: string }>(
      `SELECT id,room_id FROM messages WHERE id=ANY($1::text[]) AND deleted_at IS NULL`, [ids], 'phone-room-card-sources-0',
    );
    const rooms = new Map(rows.rows.map(row => [row.id, row.room_id]));
    return messages.map(message => {
      const card = message.grantRequest ?? message.squireApproval;
      const sourceRoomId = card?.sourceMessageId ? rooms.get(card.sourceMessageId) : undefined;
      if (!sourceRoomId || sourceRoomId === card?.sourceRoomId) return message;
      // Navigation still opens the destination through its normal membership check.
      return message.grantRequest
        ? { ...message, grantRequest: { ...message.grantRequest, sourceRoomId } }
        : { ...message, squireApproval: { ...message.squireApproval!, sourceRoomId } };
    });
  }


  /** Project historical Room openings without private objectives or lifecycle outcomes. */
  export async function phoneDecorateCornerOpenCards(ctx: PhoneContext, roomId: string, messages: RoomViewMessage[]): Promise<RoomViewMessage[]> {
    messages = await phoneDecorateApprovalIdentities(ctx, messages);
    messages = await phoneDecorateApprovalSources(ctx, messages);
    messages = await phoneDecorateVoiceCallReasons(ctx, roomId, messages);
    const cornerIds = [...new Set(messages.flatMap((message) => {
      const card = message.daemonFact;
      return card && ['corner-open', 'corner-complete'].includes(card.type) && UUID_PATTERN.test(card.cornerId)
        ? [card.cornerId] : [];
    }))];
    if (!cornerIds.length) return messages;
    const rows = await ctx.database.query<{
      id: string; name: string; message_id: string; opening_name: string | null;
    }>(
      `SELECT corner.id,corner.name,message.id message_id,message.card->>'name' opening_name
       FROM rooms corner JOIN messages message
         ON message.room_id=$2 AND message.card->>'cornerId'=corner.id::text
       WHERE corner.id=ANY($1::uuid[]) AND corner.parent_id=$2 AND message.id=ANY($3::text[])`,
      [cornerIds, roomId, messages.map(message => message.id)], 'phone-room-cards-0',
    );
    const current = new Map(rows.rows.map((row) => [row.message_id, row]));
    return messages.map((message) => {
      const card = message.daemonFact;
      const corner = card ? current.get(message.id) : undefined;
      if (!corner || !card) return message;
      // The Room's opening record is historical. Older servers settled it in
      // storage; project its original opening state without rewriting the row.
      if (card.type !== 'corner-open' && message.systemEvent?.kind !== 'corner-opened' && !card.sourceMessageId) return message;
      const { outcome: _outcome, pullRequest: _pullRequest, ...opening } = card;
      return { ...message, daemonFact: { ...opening, name: corner.opening_name ?? corner.name, objective: corner.opening_name ?? corner.name, type: 'corner-open' as const } };
    });
  }


  export async function phoneDecorateMessageCards(ctx: PhoneContext, roomId: string, messages: RoomViewMessage[], viewerId: string): Promise<RoomViewMessage[]> {
    messages = messages.filter(message => !message.onboarding || message.onboarding.requesterId === viewerId);
    return phoneDecorateCornerOpenCards(ctx, roomId, await phoneDecorateAppSignInCards(ctx, messages));
  }


  /** Approval snapshots can outlive an avatar. Resolve all their identities in one read. */
  export async function phoneDecorateApprovalIdentities(ctx: PhoneContext, messages: RoomViewMessage[]): Promise<RoomViewMessage[]> {
    const ids = new Set<string>();
    for (const message of messages) {
      const card = message.grantRequest ?? message.squireApproval;
      if (!card) continue;
      for (const person of [card.agent, card.owner,
        ...('requester' in card ? [card.requester] : [])]) {
        if (person?.pubkey) ids.add(person.pubkey);
      }
    }
    if (!ids.size) return messages;
    const rows = await ctx.database.query<IdentityRow>(
      `SELECT id,kind,name,handle,avatar,face_id FROM identities WHERE id=ANY($1::text[])`,
      [[...ids]], 'phone-room-card-identities-0',
    );
    const current = new Map(rows.rows.map(row => [row.id, identity(row, ctx.publicOrigin)]));
    const resolve = (person: RoomViewIdentity): RoomViewIdentity =>
      !person ? person : current.get(person.pubkey) ?? {
        ...person,
        ...(person.avatar ? { avatar: assetUrl(person.avatar, ctx.publicOrigin) } : {}),
      };
    return messages.map(message => ({
      ...message,
      ...(message.grantRequest ? { grantRequest: {
        ...message.grantRequest,
        agent: resolve(message.grantRequest.agent),
        owner: resolve(message.grantRequest.owner),
        requester: resolve(message.grantRequest.requester),
      } } : {}),
      ...(message.squireApproval ? { squireApproval: {
        ...message.squireApproval,
        agent: resolve(message.squireApproval.agent),
        ...(message.squireApproval.owner ? { owner: resolve(message.squireApproval.owner) } : {}),
      } } : {}),
    }));
  }


  export async function phoneDecorateAppSignInCards(ctx: PhoneContext, messages: RoomViewMessage[]): Promise<RoomViewMessage[]> {
    const keys = messages.flatMap((message) =>
      message.appSignIn ? [composioToolkitForApp(message.appSignIn.appKey)] : [],
    );
    if (!keys.length || !ctx.composio) return messages;
    const catalog = await phoneOptionalEnrichment(ctx, 'app-card-metadata', phoneReadAppCatalog(ctx, keys));
    const metadata = new Map(catalog?.map((item) => [item.appKey, item]));
    return messages.map((message) => {
      const card = message.appSignIn;
      if (!card) return message;
      const app = metadata.get(composioToolkitForApp(card.appKey));
      if (!app) return message;
      return {
        ...message,
        appSignIn: {
          ...card,
          ...(app.logo ? { logo: app.logo } : {}),
          ...(app.domain ? { domain: app.domain } : {}),
        },
      };
    });
  }
