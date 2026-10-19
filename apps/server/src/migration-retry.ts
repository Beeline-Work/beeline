/** Postgres reports a deadlock victim with SQLSTATE 40P01. */
export function isDeadlock(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '40P01';
}

/** Split a migration script without breaking SQL strings, comments, or PL/pgSQL
 * dollar-quoted bodies. Each returned statement can have its own lock retry. */
export function splitMigrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let state: 'plain' | 'single' | 'double' | 'line' | 'block' | 'dollar' = 'plain';
  let dollarTag = '';
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (state === 'line') {
      if (char === '\n') state = 'plain';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'plain'; index++; }
      continue;
    }
    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        state = 'plain';
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (char === quote) {
        if (next === quote) index++;
        else state = 'plain';
      }
      continue;
    }
    if (char === '-' && next === '-') { state = 'line'; index++; continue; }
    if (char === '/' && next === '*') { state = 'block'; index++; continue; }
    if (char === "'") { state = 'single'; continue; }
    if (char === '"') { state = 'double'; continue; }
    if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(index));
      if (match) {
        dollarTag = match[0];
        state = 'dollar';
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (char === ';') {
      const statement = sql.slice(start, index + 1).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  if (state !== 'plain' && state !== 'line')
    throw new Error(`unterminated ${state} in migration SQL`);
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Lock timeout and deadlock are contention with live traffic, not a reason
 * to repeat completed release steps. Call this around each DDL statement. */
export async function retryMigrationStep(
  name: string,
  run: () => Promise<void>,
  options: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
    /** Runs after every lock timeout, before the retry or the final throw. */
    onLockTimeout?: () => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? ((attempt) => 1_000 * attempt + Math.floor(Math.random() * 500));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '55P03') await options.onLockTimeout?.().catch(() => undefined);
      if ((code !== '40P01' && code !== '55P03') || attempt >= attempts) throw error;
      const wait = delayMs(attempt);
      console.warn(`[migration] ${name} lock conflict on attempt ${attempt}/${attempts}; retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

/**
 * The release migration runs against live traffic, so a schema statement can
 * lose a lock race and be chosen as a deadlock victim. Every step is
 * idempotent, so the safe response is to run the whole migration again after a
 * short backoff rather than fail the release.
 */
export async function retryOnDeadlock(
  run: () => Promise<void>,
  options: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 6;
  const delayMs =
    options.delayMs ?? ((attempt) => 2_000 * attempt + Math.floor(Math.random() * 1_000));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      if (!isDeadlock(error) || attempt >= attempts) throw error;
      const wait = delayMs(attempt);
      console.warn(`[migration] deadlock on attempt ${attempt}/${attempts}; retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

type DiagnosticDatabase = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  transaction<T>(work: (database: DiagnosticDatabase) => Promise<T>): Promise<T>;
};

const LOCKED_TABLE =
  /\b(?:ALTER\s+TABLE|LOCK\s+TABLE|DROP\s+TABLE|TRUNCATE(?:\s+TABLE)?|REFERENCES|UPDATE|INSERT\s+INTO|DELETE\s+FROM|ON)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/gi;

/** Table names a migration statement locks. Unknown words resolve to no table. */
export function lockedTables(statement: string): string[] {
  return [...new Set([...statement.matchAll(LOCKED_TABLE)].map((match) => match[1]!.toLowerCase()))];
}

/** A lock timeout leaves no record of who held the table. Log the sessions
 * that hold or wait on its locks. Read-only, short timeouts, never throws. */
export async function logLockHolders(
  database: DiagnosticDatabase,
  name: string,
  statement: string,
): Promise<void> {
  const tables = lockedTables(statement);
  try {
    const { rows } = await database.transaction(async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = '2000ms'`);
      await tx.query(`SET LOCAL lock_timeout = '500ms'`);
      return tx.query(
        `SELECT l.relation::regclass::text AS relation, l.mode, l.granted, a.pid, a.state,
           a.wait_event_type, a.wait_event, a.xact_start::text AS xact_start,
           a.query_start::text AS query_start, a.application_name, left(a.query, 200) AS query
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'relation' AND l.pid <> pg_backend_pid()
           AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND (cardinality($1::text[]) = 0
             OR l.relation IN (SELECT to_regclass(t) FROM unnest($1::text[]) t))
         ORDER BY a.xact_start NULLS LAST
         LIMIT 20`,
        [tables],
      );
    });
    console.warn(`[migration] ${name} lock holders on ${tables.join(',') || 'any table'}: ${rows.length}`);
    for (const row of rows) console.warn('[migration] lock holder', row);
  } catch (error) {
    console.warn(`[migration] ${name} lock holder diagnostic failed: ${(error as Error)?.message ?? error}`);
  }
}
