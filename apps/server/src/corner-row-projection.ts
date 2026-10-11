/** Columns projected from source tables into a parent's corner row. */
export const CORNER_ROW_ROOM_COLUMNS = [
  'parent_id', 'name', 'about', 'avatar', 'visibility', 'reviewer_agent_id',
  'reviewer_fallback_ids', 'archived_at', 'created_at', 'updated_at',
] as const;
export const cornerRoomColumnsSql = `c.id,c.workspace_id,${CORNER_ROW_ROOM_COLUMNS.map(
  (column) => `c.${column}`,
).join(',')}`;
export const CORNER_ROW_FACT_COLUMNS = [
  'lifecycle', 'workflow_state', 'workflow_outcome', 'commissioned_by', 'owner_agent_id', 'objective',
] as const;
/** The latest-message (`lm`) columns, including those its visibility rule reads. */
export const CORNER_ROW_MESSAGE_COLUMNS = [
  'id', 'room_id', 'author_id', 'text', 'created_at', 'presentation', 'deleted_at', 'card_type',
] as const;

/** For a row trigger: the row was inserted or deleted, or one of `columns` changed. */
export function rowChangedSql(columns: readonly string[]): string {
  const row = (record: string) => `ROW(${columns.map((column) => `${record}.${column}`).join(',')})`;
  return `(CASE WHEN TG_OP <> 'UPDATE' THEN true ELSE ${row('NEW')} IS DISTINCT FROM ${row('OLD')} END)`;
}
