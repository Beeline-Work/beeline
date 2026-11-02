import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import { COMMAND_COMPLETION_CHANNEL, COMMAND_COMPLETION_SCHEMA, notifyCommandCompletion } from './command-completion.js';
import { waitForConnection } from './connection-wait.js';

describe('F26 committed completion capture', () => {
  let db: PgliteDatabase, release: () => Promise<void>;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await db.query(`CREATE TABLE workspace_connectors(id text PRIMARY KEY,status text,sign_in jsonb,status_error text);
      CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text,machine_id text,squire_work jsonb,squire_report jsonb);
      CREATE TABLE rooms_mcp_idempotency(member_id text,idempotency_key text,message_id text,result jsonb);`);
    await db.query(COMMAND_COMPLETION_SCHEMA);
    release = await db.client.listen(COMMAND_COMPLETION_CHANNEL, payload => notifyCommandCompletion(payload));
  });
  afterEach(async () => { await release(); await db.close(); });
  it('one initial status read waits for actual committed connector completion', async () => {
    await db.query("INSERT INTO workspace_connectors VALUES('connector-1','installing',NULL,NULL)");
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const read = vi.fn(async () => {
      const row = (await db.query<{ status: string }>("SELECT status FROM workspace_connectors WHERE id='connector-1'")).rows[0];
      readStarted();
      return row?.status === 'connected' ? row.status : undefined;
    });
    const waiting = waitForConnection(read, 1000, { principal: 'connector', operation: 'status', commandId: 'connector-1' });
    await started;
    expect(read).toHaveBeenCalledTimes(1);
    await db.query("UPDATE workspace_connectors SET status='connected' WHERE id='connector-1'");
    expect(await waiting).toBe('connected');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('completion before interest is recovered by the single initial inspection', async () => {
    await db.query("INSERT INTO workspace_connectors VALUES('already','connected',NULL,NULL)");
    const read = vi.fn(async () => (await db.query<{ status: string }>("SELECT status FROM workspace_connectors WHERE id='already'")).rows[0]?.status);
    expect(await waitForConnection(read, 1000, { principal: 'connector', operation: 'status', commandId: 'already' })).toBe('connected');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('does not publish a rolled back completion and coalesces unrelated updates', async () => {
    const received = vi.fn();
    const stop = await db.client.listen(COMMAND_COMPLETION_CHANNEL, received);
    try {
      await db.query("INSERT INTO workspace_connectors VALUES('rollback','installing',NULL,NULL)");
      received.mockClear();
      await expect(db.transaction(async tx => {
        await tx.query("UPDATE workspace_connectors SET status='connected' WHERE id='rollback'");
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(received).not.toHaveBeenCalled();
      await db.query("UPDATE workspace_connectors SET status=status WHERE id='rollback'");
      expect(received).not.toHaveBeenCalled();
    } finally { await stop(); }
  });
});
