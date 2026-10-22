import type { SqlDatabase } from './database.js';

export type VoiceContextRow = {
  id: string; text: string; author_id: string; name: string; handle: string | null;
  attachments: { title?: string; name?: string; url?: string }[];
  card_type: string | null; card: Record<string, unknown> | null;
};

/** Speaker labels and item references survive the small conversational prompt budget. */
export function voiceContextText(row: VoiceContextRow): string {
  const reference = `#beeline/item/${row.id}`;
  const items = (row.attachments ?? []).slice(0, 8).map(item =>
    `${(item.title ?? item.name ?? 'Attachment').slice(0, 120)}: ${(item.url ?? '').slice(0, 512)}`);
  if (row.card_type) items.push(`${String(row.card?.title ?? row.card?.name ?? row.card_type).slice(0, 120)}: ${
    typeof row.card?.url === 'string' ? row.card.url.slice(0, 512) : reference}`);
  return `${row.name ?? row.author_id}${row.handle ? ` (@${row.handle})` : ''} [${reference}]: ${row.text.slice(0, 800)}${items.length ? '\n' + items.join('\n') : ''}`.slice(0, 1600);
}

export async function readVoiceContext(db: SqlDatabase, roomId: string, sourceId: string, agentId: string) {
  const rows = await db.query<VoiceContextRow>(
    `SELECT m.id,left(m.text,800) text,m.author_id,i.name,i.handle,m.attachments,m.card_type,
       jsonb_build_object('title',m.card->>'title','name',m.card->>'name','url',m.card->>'url') card
     FROM messages m JOIN identities i ON i.id=m.author_id
     WHERE m.room_id=$1 AND m.id<>$2 AND m.presentation IN ('message','card') AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC,m.id DESC LIMIT 16`, [roomId, sourceId]);
  return rows.rows.reverse().map(row => ({ role: row.author_id === agentId ? 'assistant' as const : 'user' as const,
    content: voiceContextText(row) }));
}
