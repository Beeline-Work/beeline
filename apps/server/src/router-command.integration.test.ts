import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from "../../../tests/helpers/server.js";
import { RouterCommandLedger, ROUTER_COMMAND_SCHEMA, CommandDigestConflict, commandArgumentDigest } from './router-command-ledger.js';
import { notifyCommandCompletion, recoverCommandCompletions, subscribeCommandCompletion, waitForCommittedChange } from './command-completion.js';
import { CommandScopedDatabase } from './command-scoped-database.js';

const key = { principal: 'reader', operation: 'create', commandId: 'intent-1' };
describe('P7 durable command identity', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await database.query(ROUTER_COMMAND_SCHEMA);
    await database.query('CREATE TABLE effects(id text PRIMARY KEY, value integer NOT NULL)');
  });
  afterEach(async () => { await database.close(); });
  it('commit then lost reply retries on another server with one effect and one original result', async () => {
    const first = new RouterCommandLedger(database), replacement = new RouterCommandLedger(database);
    const effect = vi.fn(async (tx) => {
      await tx.query('INSERT INTO effects VALUES($1,$2)', ['once', 42]);
      return { effectId: 'once', value: 42 };
    });
    // The first caller abandons this receipt: the committed effect survives.
    await first.atomic(key, { target: 'once', value: 42 }, effect);
    expect(await replacement.atomic(key, { value: 42, target: 'once' }, effect))
      .toMatchObject({ state: 'committed', result: { effectId: 'once', value: 42 } });
    expect(effect).toHaveBeenCalledTimes(1);
    expect((await database.query('SELECT * FROM effects')).rows).toHaveLength(1);
  });
  it('different canonical arguments conflict before a second effect', async () => {
    const ledger = new RouterCommandLedger(database), effect = vi.fn(async () => ({ id: 'effect' }));
    await ledger.atomic(key, { target: 'A' }, effect);
    await expect(ledger.atomic(key, { target: 'B' }, effect)).rejects.toBeInstanceOf(CommandDigestConflict);
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('principal and operation independently scope the same command id', async () => {
    const ledger = new RouterCommandLedger(database), effect = vi.fn(async () => ({ ok: true }));
    await ledger.atomic(key, {}, effect);
    await ledger.atomic({ ...key, principal: 'other' }, {}, effect);
    await ledger.atomic({ ...key, operation: 'another' }, {}, effect);
    expect(effect).toHaveBeenCalledTimes(3);
  });
  it('rolls back effect and claim together and allows the unchanged intent after rollback', async () => {
    const ledger = new RouterCommandLedger(database);
    await expect(ledger.atomic(key, {}, async tx => {
      await tx.query("INSERT INTO effects VALUES('rolled-back',1)");
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect((await database.query('SELECT * FROM effects')).rows).toEqual([]);
    expect((await database.query('SELECT * FROM router_commands')).rows).toEqual([]);
    await expect(ledger.atomic(key, {}, async () => 'retry after proven rollback')).resolves.toMatchObject({ state: 'committed' });
  });
  it('keeps a permanent identity/digest fence after 31 days and result compaction', async () => {
    const ledger = new RouterCommandLedger(database), effect = vi.fn(async () => ({ paymentId: 'once' }));
    await ledger.atomic(key, { amount: 5 }, effect);
    await database.query("UPDATE router_commands SET result_expires_at=now()-interval '1 day',completed_at=now()-interval '31 days'");
    expect(await ledger.compactResults()).toBe(1);
    expect(await ledger.atomic(key, { amount: 5 }, effect)).toMatchObject({ state: 'result-expired' });
    await expect(ledger.atomic(key, { amount: 6 }, effect)).rejects.toBeInstanceOf(CommandDigestConflict);
    expect(effect).toHaveBeenCalledTimes(1);
    expect((await database.query('SELECT result,digest FROM router_commands')).rows[0]).toMatchObject({ result: null });
  });
  it('does not redispatch a provider without idempotency after response loss', async () => {
    const first = new RouterCommandLedger(database), second = new RouterCommandLedger(database);
    const effect = vi.fn(async () => { throw new Error('provider result lost after dispatch'); });
    await expect(first.external(key, { amount: 5 }, effect)).rejects.toThrow('result lost');
    expect(await second.external(key, { amount: 5 }, effect)).toMatchObject({ state: 'unknown' });
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('two server instances join a pending external intent without reclaiming or redispatch', async () => {
    const first = new RouterCommandLedger(database), second = new RouterCommandLedger(database);
    let release!: () => void, started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const effect = vi.fn(async () => { started(); await blocked; return { effectId: 'once' }; });
    const original = first.external(key, {}, effect);
    await running;
    expect(await second.external(key, {}, effect)).toMatchObject({ state: 'pending' });
    const completion = second.wait(key, {}, 1000);
    release();
    await original;
    expect(await completion).toMatchObject({ state: 'committed', result: { effectId: 'once' } });
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('scopes nested service database work to the same effect transaction', async () => {
    const serviceDb = new CommandScopedDatabase(database), ledger = new RouterCommandLedger(database);
    await expect(ledger.atomic(key, {}, tx => serviceDb.run(tx, async () => {
      expect(serviceDb.active).toBe(true);
      await serviceDb.transaction(async nested => { await nested.query("INSERT INTO effects VALUES('nested',1)"); });
      throw new Error('rollback all');
    }))).rejects.toThrow('rollback all');
    expect(serviceDb.active).toBe(false);
    expect((await database.query('SELECT * FROM effects')).rows).toEqual([]);
  });
  it('canonical digest is stable and rejects non-JSON or unbounded input', () => {
    expect(commandArgumentDigest('send', { b: 2, a: [1, -0] })).toBe(commandArgumentDigest('send', { a: [1, 0], b: 2 }));
    expect(() => commandArgumentDigest('send', { amount: Infinity })).toThrow('invalid_command_arguments');
    expect(() => commandArgumentDigest('send', { text: 'x'.repeat(65536) })).toThrow('invalid_command_arguments');
  });
});

describe('P7/P12 subscribe-before-read completion', () => {
  it('observes completion already committed when the listener is installed', async () => {
    const read = vi.fn(async () => 'committed');
    const unsubscribe = vi.fn();
    await expect(waitForCommittedChange(() => unsubscribe, read, 1000)).resolves.toBe('committed');
    expect(read).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('retains an event arriving during the first inspection', async () => {
    let listener!: () => void, resolveRead!: (value: string | undefined) => void;
    const blocked = new Promise<string | undefined>(resolve => { resolveRead = resolve; });
    const read = vi.fn().mockImplementationOnce(() => blocked).mockResolvedValue('completed-during-read');
    const release = vi.fn();
    const result = waitForCommittedChange(next => { listener = next; return release; }, read, 1000);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    listener(); resolveRead(undefined);
    expect(await result).toBe('completed-during-read');
    expect(read).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('pending 85 seconds performs one inspection; terminal deadline removes listener', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => undefined), release = vi.fn();
      const waiting = waitForCommittedChange(() => release, read, 85_000);
      await vi.advanceTimersByTimeAsync(84_999);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await waiting).toBeUndefined();
      expect(release).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('actual listener recovery wakes durable inspection; unrelated command does not', async () => {
    const wake = vi.fn(), stop = subscribeCommandCompletion(key, wake);
    notifyCommandCompletion({ ...key, principal: 'unrelated' });
    expect(wake).not.toHaveBeenCalled();
    recoverCommandCompletions();
    expect(wake).toHaveBeenCalledTimes(1);
    stop(); notifyCommandCompletion(key);
    expect(wake).toHaveBeenCalledTimes(1);
  });
  it('cancellation removes the waiter without canceling an admitted effect', async () => {
    const controller = new AbortController(), release = vi.fn();
    const waiting = waitForCommittedChange(() => release, async () => undefined, 1000, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort(new Error('stopped waiting'));
    await expect(waiting).rejects.toThrow('stopped waiting');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
