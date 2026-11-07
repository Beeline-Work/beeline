import type { PGliteInterface } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { migratedDatabase, PgliteDatabase } from './test-support.js';

it('clones the provided schema without migrating again, including coverage runs', async () => {
  const snapshot = vi.spyOn(PgliteDatabase.prototype, 'snapshot')
    .mockRejectedValue(new Error('fixture schema must be prepared once in global setup'));
  try {
    const database = await migratedDatabase();
    try {
      expect((await database.query(`SELECT count(*)::integer AS count FROM agent_commands`)).rows)
        .toEqual([{ count: 0 }]);
      expect(snapshot).not.toHaveBeenCalled();
    } finally { await database.close(); }
  } finally { snapshot.mockRestore(); }
});

describe('PgliteDatabase teardown', () => {
  it('releases the engine even when a service or spy retains the wrapper', async () => {
    const engine = { close: vi.fn(async () => undefined) };
    const retained = new PgliteDatabase(engine as unknown as PGliteInterface);
    await retained.close();
    expect(engine.close).toHaveBeenCalledOnce();
    expect(() => retained.client).toThrow('Test database is closed');
    await expect(retained.query('SELECT 1')).rejects.toThrow('Test database is closed');
    await retained.close();
    expect(engine.close).toHaveBeenCalledOnce();
  });

  it('keeps the engine available until background work and engine shutdown finish', async () => {
    const events: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const engine = { close: vi.fn(async () => {
      expect(database.client).toBe(engine);
      events.push('close');
    }) };
    const database = new PgliteDatabase(engine as unknown as PGliteInterface);
    database.backgroundWork.run(async () => {
      await pending;
      expect(database.client).toBe(engine);
      events.push('background');
    });
    const closing = database.close();
    expect(database.client).toBe(engine);
    expect(engine.close).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(events).toEqual(['background', 'close']);
    expect(() => database.client).toThrow('Test database is closed');
  });

  it('releases the engine when shutdown fails', async () => {
    const engine = { close: vi.fn(async () => { throw new Error('shutdown failed'); }) };
    const database = new PgliteDatabase(engine as unknown as PGliteInterface);
    await expect(database.close()).rejects.toThrow('shutdown failed');
    expect(() => database.client).toThrow('Test database is closed');
  });
});
