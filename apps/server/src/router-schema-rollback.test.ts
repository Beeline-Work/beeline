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

it('keeps the schema46 historical boot contract without a phone read marker', async () => {
  const database = new PgliteDatabase();
  const old = historicalReadiness();
  try {
    expect(old.REQUIRED_SCHEMA_VERSION).toBe(46);
    await expect(assertSchemaCurrent(database)).rejects.toThrow('release migration step');
    await old.markSchemaCurrent(database);
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
    await markSchemaCurrent(database);
    await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
    expect((await database.query('SELECT version FROM beeline_schema_state')).rows).toEqual([{ version: 46 }]);
    expect((await database.query("SELECT to_regclass('beeline_router_schema_state') marker")).rows).toEqual([{ marker: null }]);
    await old.markSchemaCurrent(database);
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
    await database.query('UPDATE beeline_schema_state SET version=45');
    await expect(assertSchemaCurrent(database)).rejects.toThrow('expected schema version 46, found 45');
  } finally {
    await database.close();
  }
}, 20_000);
