import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { ReleaseNotifier } from './release-notify.js';

const OWNER = 'a'.repeat(64);
const OTHER_PERSON = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
      ($1,'human','Owner'),($2,'human','Other'),($3,'agent','Worker')`,
    [OWNER, OTHER_PERSON, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
    [ROOM, WORKSPACE, OWNER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
    [WORKSPACE, OWNER, OTHER_PERSON, AGENT, ROOM],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  return database;
}

describe('helper release delivery', () => {
  let database: PgliteDatabase;
  beforeEach(async () => { database = await fixture(); });
  afterEach(() => database.close());

  it('wakes helpers without posting any message or creating any bot DM', async () => {
    const notifier = new ReleaseNotifier(database);
    const push = vi.fn();
    const stop = notifier.subscribeHelperRelease(push);
    const input = { version: 'v0.0.128', sha: 'a'.repeat(40), changelogUrl: 'https://example.test/128' };
    expect(await notifier.notifyReleaseDelivered(input)).toEqual({ notified: 0, skipped: 0 });
    await notifier.notifyReleaseDelivered(input);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ version: input.version, sha: input.sha });
    expect((await database.query('SELECT 1 FROM messages')).rowCount).toBe(0);
    expect((await database.query('SELECT 1 FROM rooms WHERE direct_participants IS NOT NULL')).rowCount).toBe(0);
    stop();
  });

  it('stores the delivered helper release and pushes it to connected and later subscribers', async () => {
    const notifier = new ReleaseNotifier(database);
    const connected: string[] = [];
    const release = notifier.subscribeHelperRelease(({ sha }) => connected.push(sha));
    await notifier.notifyReleaseDelivered({
      version: 'v0.0.128', sha: 'a'.repeat(40), changelogUrl: 'https://example.test/128',
    });
    expect(connected).toContain('a'.repeat(40));
    release();
    const reconnect = new ReleaseNotifier(database);
    const offline: string[] = [];
    const stop = reconnect.subscribeHelperRelease(({ sha }) => offline.push(sha));
    await vi.waitFor(() => expect(offline).toContain('a'.repeat(40)));
    stop();
  });

  it('does not query again during five idle minutes and reconciles once on reconnect', async () => {
    const live = new LiveHub();
    const query = vi.spyOn(database, 'query');
    const notifier = new ReleaseNotifier(database, { live });
    const received: string[] = [];
    const stop = notifier.subscribeHelperRelease(({ sha }) => received.push(sha));
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    live.publish({ type: 'helper-release',
      version: 'v0.0.128', sha: 'a'.repeat(40) });
    expect(received).toEqual(['a'.repeat(40)]);
    expect(query).toHaveBeenCalledTimes(1);
    live.resync();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    await database.query('SELECT 1'); // Drain the queued reconcile before closing PGlite.
    const late = notifier.subscribeHelperRelease(() => {});
    expect(query).toHaveBeenCalledTimes(3);
    late();
    stop();
  });

});
