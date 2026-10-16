import type { SqlDatabase } from '../database.js';
import { deleteCornerWakeSources } from '../corner-wake-cleanup.js';

/** Release cleanup for wake sources left behind by earlier corner archival paths. */
export async function deleteArchivedCornerWakeSources(database: SqlDatabase): Promise<void> {
  await database.transaction(async (database) => {
    const corners = await database.query<{ id: string }>(
      `SELECT id FROM rooms WHERE parent_id IS NOT NULL AND archived_at IS NOT NULL`,
    );
    await deleteCornerWakeSources(database, corners.rows.map((corner) => corner.id));
  });
}
