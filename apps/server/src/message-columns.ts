/** Explicit current message-row projection, shared by stored-row readers. */
const columns = [
  'id','room_id','author_id','text','presentation',
  'attachments','reactions','reply_to_message_id','root_message_id','request_id',
  'turn_id','activity','durable_fact','card_type','card',
  'legacy_event','agent_hop_count','system_event','deleted_at','deleted_by',
  'created_at','version','search_document','search_stem_document','event_cause_id',
  'event_root_cause_id','event_depth','agent_model','source_client',
] as const;

export function messageColumns(alias: string): string {
  return columns.map(column => `${alias}.${column}`).join(',');
}
