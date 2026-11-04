import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { assertSchemaCurrent, markSchemaCurrent, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';

// Execute retained historical source, not a reimplementation of its equality
// check. Only the successful database-read path is in scope. Any retry/error
// helper invocation fails immediately rather than scheduling historical timers.
function historicalReadiness() {
  const exports = {} as {
    REQUIRED_SCHEMA_VERSION: number;
    markSchemaCurrent(database: SqlDatabase): Promise<void>;
    assertSchemaCurrent(database: SqlDatabase): Promise<void>;
  };
  const unexpected = () => { throw new Error('Historical retry path is outside this proof'); };
  const source = readFileSync(new URL('./fixtures/schema46-readiness.source.txt', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(outputText, {
    exports, pause: unexpected, isTransientDatabaseConnectionError: unexpected,
    SCHEMA_RETRY_DELAYS_MS: [],
  });
  return exports;
}

it('keeps historical boot valid through additive readiness while requiring completed router migrations', async () => {
  const database = new PgliteDatabase();
  const old = historicalReadiness();
  try {
    expect(old.REQUIRED_SCHEMA_VERSION).toBe(46);
    await old.markSchemaCurrent(database);
    await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(database)).rejects.toThrow('release migration step');

    await markSchemaCurrent(database);
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
    await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
    expect((await database.query('SELECT version FROM beeline_schema_state')).rows).toEqual([{ version: 46 }]);
    expect((await database.query('SELECT version FROM beeline_router_schema_state')).rows).toEqual([{ version: 62 }]);

    // A historical migration can still mark its baseline without deleting the
    // additive marker. This does not claim it understands router commands.
    await old.markSchemaCurrent(database);
    await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();

    await database.query('UPDATE beeline_router_schema_state SET version=60');
    await expect(assertSchemaCurrent(database)).rejects.toThrow('expected router schema version 62, found 60');
    await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
    await database.query('DELETE FROM beeline_router_schema_state');
    await expect(assertSchemaCurrent(database)).rejects.toThrow('expected router schema version 62, found no marker');
    await markSchemaCurrent(database);
    await database.query('UPDATE beeline_schema_state SET version=45');
    await expect(assertSchemaCurrent(database)).rejects.toThrow('expected schema version 46, found 45');
  } finally {
    await database.close();
  }
}, 20_000);
