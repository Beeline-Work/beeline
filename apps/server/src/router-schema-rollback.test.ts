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

it('demonstrates why swapping schema46 and schema61 images cannot roll back the shared marker', async () => {
  const database = new PgliteDatabase();
  const old = historicalReadiness();
  try {
    expect(old.REQUIRED_SCHEMA_VERSION).toBe(46);
    await old.markSchemaCurrent(database);
    await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(database)).rejects.toThrow('expected schema version 61, found 46');

    // The release migration writes this marker last; image rollback does not
    // rewrite it. This is a marker compatibility proof, not full schema/DDL or
    // old-server application compatibility, nor a deployed-image claim.
    await markSchemaCurrent(database);
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
    await expect(old.assertSchemaCurrent(database)).rejects.toThrow('expected schema version 46, found 61');

    // Rewinding just the marker reverses the failure. It does not create a
    // shared serving floor or prove that retained commands can be understood.
    await old.markSchemaCurrent(database);
    await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(database)).rejects.toThrow('expected schema version 61, found 46');
  } finally {
    await database.close();
  }
}, 20_000);
