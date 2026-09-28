import { describe, expect, it, vi } from 'vitest';
import type { QueryResult, SqlDatabase } from './database.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const ROOM = '11111111-1111-4111-8111-111111111111';
const AGENT = 'a'.repeat(64);

describe('daemon room access', () => {
  it('checks membership once when listing a Room\'s corners', async () => {
    const query = vi.fn(async <Row>(sql: string): Promise<QueryResult<Row>> => {
      if (sql.includes('FROM memberships WHERE room_id=$1'))
        return { rows: [{ corner_reviewer: false, is_corner: false }] as Row[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const database = { query } as unknown as SqlDatabase;
    const daemon = new DaemonService(database, new LiveHub());

    await expect(daemon.execute('listRoomCorners', { roomId: ROOM }, AGENT))
      .resolves.toEqual({ corners: [] });
    expect(query.mock.calls.filter(([sql]) => sql.includes('FROM memberships WHERE room_id=$1')))
      .toHaveLength(1);
  });

  it('checks membership once when restoring a corner', async () => {
    const query = vi.fn(async <Row>(sql: string): Promise<QueryResult<Row>> => {
      if (sql.includes('FROM memberships WHERE room_id=$1'))
        return { rows: [{ corner_reviewer: false, is_corner: true }] as Row[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const daemon = new DaemonService({ query } as unknown as SqlDatabase, new LiveHub());

    await daemon.execute('getCornerRestoreState', { cornerId: ROOM }, AGENT);
    expect(query.mock.calls.filter(([sql]) => sql.includes('FROM memberships WHERE room_id=$1')))
      .toHaveLength(1);
  });
});
