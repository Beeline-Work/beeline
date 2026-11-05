import { expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgresDatabase, migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { CommandRefusalError } from './commander.js';
import { ComposioApps } from './composio-apps.js';

it('Reproduction SENTRY-1: concurrent and repeated database closes end the pool once', async () => {
  let complete!: () => void;
  const end = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  const database = new PostgresDatabase('', 1, { pool: { on: vi.fn(), end } as unknown as Pool });
  const first = database.close();
  const second = database.close();
  expect(end).toHaveBeenCalledOnce();
  expect(second).toBe(first);
  complete();
  await Promise.all([first, second, database.close()]);
  expect(end).toHaveBeenCalledOnce();
});

it('retains the original pool cleanup failure on repeated close', async () => {
  const failure = new Error('cleanup failed');
  const end = vi.fn(async () => { throw failure; });
  const database = new PostgresDatabase('', 1, { pool: { on: vi.fn(), end } as unknown as Pool });
  await expect(database.close()).rejects.toBe(failure);
  await expect(database.close()).rejects.toBe(failure);
  expect(end).toHaveBeenCalledOnce();
});

it('Reproduction SENTRY-3: missing installation posts the install prompt and refuses with 409', async () => {
  const db = new PgliteDatabase();
  const agent = 'a'.repeat(64), owner = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent'),($2,'human','Owner')`, [agent, owner]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Refusal test')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, room, agent]);
    const daemon = new DaemonService(db, new LiveHub(), async () => { throw new Error('GitHub repository installation not found'); });
    const failure = await daemon.execute('getRoomGitHubToken', { roomId: room }, agent).catch(error => error);
    expect(failure).toBeInstanceOf(CommandRefusalError);
    expect(failure).toMatchObject({ status: 409, message: 'Room repository access needs the Beeline GitHub App' });
    const messages = await db.query<{ text: string }>('SELECT text FROM messages WHERE room_id=$1', [room]);
    expect(messages.rows.map(row => row.text).join('\n')).toContain('Install or grant the Beeline GitHub App');
  } finally { await db.close(); }
}, 30_000);

it('Reproduction SENTRY-4: invalid app tool returns a clear 400 before provider access', async () => {
  const transport = vi.fn();
  const provider = new ComposioApps('fixture', transport);
  const failure = await provider.execute({ accountId: 'account', userId: 'person', toolkit: 'gmail', tool: '../bad', arguments: {} }).catch(error => error);
  expect(failure).toBeInstanceOf(CommandRefusalError);
  expect(failure).toMatchObject({ status: 400, message: 'Invalid app tool' });
  expect(transport).not.toHaveBeenCalled();
});

it('Reproduction SENTRY-1: a real pg pool can be closed twice without an unhandled rejection', async () => {
  const database = new PostgresDatabase('', 1, { pool: new Pool() });
  await Promise.all([database.close(), database.close()]);
  await database.close();
});
