import type { SqlDatabase } from './database.js';

export const ROOM_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function roomSlug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)
      .replace(/-$/g, '') || 'room'
  );
}

export function requireRoomSlug(value: string): string {
  if (value.length > 48 || !ROOM_SLUG_PATTERN.test(value))
    throw new Error(
      'invalid Room name: use lowercase letters, numbers and single hyphens (up to 48 characters)',
    );
  return value;
}

export async function reserveRoomName(
  db: SqlDatabase,
  workspaceId: string,
  name: string,
  roomId?: string,
): Promise<void> {
  await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
  const occupied = await db.query(
    `SELECT 1 FROM rooms WHERE workspace_id=$1 AND name=$2
       AND parent_id IS NULL AND direct_participants IS NULL AND id IS DISTINCT FROM $3::uuid
     UNION ALL
     SELECT 1 FROM room_name_aliases WHERE workspace_id=$1 AND lower(name)=lower($2)
       AND room_id IS DISTINCT FROM $3::uuid LIMIT 1`,
    [workspaceId, name, roomId ?? null],
  );
  if (occupied.rowCount) throw new Error('Room name conflict: already used in this Workspace');
}

/** Preserve only old names with one unambiguous owner in their Workspace. */
export async function normalizeRoomNames(database: SqlDatabase): Promise<void> {
  await database.transaction(async (db) => {
    await db.query('SELECT id FROM workspaces ORDER BY id FOR UPDATE');
    const result = await db.query<{ id: string; workspace_id: string; name: string }>(
      `SELECT id,workspace_id,name FROM rooms
       WHERE parent_id IS NULL AND direct_participants IS NULL
       ORDER BY workspace_id,created_at,id FOR UPDATE`,
    );
    const groups = new Map<string, typeof result.rows>();
    for (const row of result.rows)
      groups.set(row.workspace_id, [...(groups.get(row.workspace_id) ?? []), row]);
    for (const [workspaceId, rows] of groups) {
      const counts = new Map<string, number>();
      for (const row of rows)
        counts.set(row.name.toLowerCase(), (counts.get(row.name.toLowerCase()) ?? 0) + 1);
      const reserved = new Map(
        rows
          .filter((row) => counts.get(row.name.toLowerCase()) === 1)
          .map((row) => [row.name.toLowerCase(), row.id]),
      );
      const used = new Set<string>();
      for (const row of rows) {
        const base = roomSlug(row.name);
        let slug = base;
        for (
          let suffix = 2;
          used.has(slug) || (reserved.has(slug) && reserved.get(slug) !== row.id);
          suffix++
        ) {
          const ending = `-${suffix}`;
          slug = `${base.slice(0, 48 - ending.length).replace(/-$/g, '')}${ending}`;
        }
        used.add(slug);
        if (row.name !== slug) {
          if (counts.get(row.name.toLowerCase()) === 1)
            await db.query(
              `INSERT INTO room_name_aliases(workspace_id,room_id,name) VALUES($1,$2,$3)
               ON CONFLICT DO NOTHING`,
              [workspaceId, row.id, row.name],
            );
          await db.query('UPDATE rooms SET name=$2,updated_at=now() WHERE id=$1', [row.id, slug]);
        }
      }
    }
  });
}
