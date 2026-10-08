import type { SqlDatabase } from '../database.js';

/**
 * Rewrite stored corner names that still contain whitespace into the
 * continuous form new names must use: the first three words (what clients
 * showed for them) joined by hyphens. A name another corner of the same Room
 * already holds gets `-2`, `-3`… in creation order. The corner's own cards in
 * its parent Room take the same name.
 */
export async function hyphenateCornerNames(database: SqlDatabase): Promise<number> {
  return database.transaction(async (db) => {
    const corners = await db.query<{ id: string; parent_id: string; name: string }>(
      `SELECT id,parent_id,name FROM rooms WHERE parent_id IS NOT NULL
       ORDER BY parent_id,created_at,id FOR UPDATE`,
    );
    const taken = new Map<string, Set<string>>();
    for (const corner of corners.rows) {
      if (/\s/.test(corner.name)) continue;
      const names = taken.get(corner.parent_id) ?? new Set<string>();
      names.add(corner.name.toLowerCase());
      taken.set(corner.parent_id, names);
    }
    let renamed = 0;
    for (const corner of corners.rows) {
      if (!/\s/.test(corner.name)) continue;
      const names = taken.get(corner.parent_id) ?? new Set<string>();
      taken.set(corner.parent_id, names);
      const base =
        corner.name.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('-') ||
        `corner-${corner.id.slice(0, 8)}`;
      let name = base;
      for (let suffix = 2; names.has(name.toLowerCase()); suffix += 1) name = `${base}-${suffix}`;
      names.add(name.toLowerCase());
      await db.query(`UPDATE rooms SET name=$2 WHERE id=$1`, [corner.id, name]);
      await db.query(
        `UPDATE messages SET card=jsonb_set(card,'{name}',to_jsonb($3::text))
         WHERE room_id=$1 AND card_type='daemon-fact' AND card->>'cornerId'=$2 AND card ? 'name'`,
        [corner.parent_id, corner.id, name],
      );
      renamed += 1;
    }
    return renamed;
  });
}
