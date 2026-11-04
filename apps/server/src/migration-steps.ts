import { retryRolledBackWork } from './background-work.js';
/** Split a migration script without breaking SQL strings, comments, or PL/pgSQL
 * dollar-quoted bodies. Each returned statement is one explicit release step. */
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

/** Retry only the current DB-only, release-owned step after a proven rollback.
 * Completed steps and uncertain transport outcomes are never replayed. */
export async function runMigrationStep(
  name: string,
  run: () => Promise<void>,
  options: { onLockTimeout?: () => Promise<void> } = {},
): Promise<void> {
  await retryRolledBackWork(async () => {
    try {
      await run();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '55P03') await options.onLockTimeout?.().catch(() => undefined);
      if (code === '40P01' || code === '55P03') console.warn(`[migration] ${name} lock conflict; retrying rolled-back step`);
      throw error;
    }
  });
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

type CatalogDatabase = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/** Split at top-level commas, ignoring commas inside parentheses or quotes. */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

const IDENT = '([A-Za-z_][A-Za-z0-9_]*)';
const ADD_COLUMN = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${IDENT}\\s+(ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+[\\s\\S]*)$`, 'i');
const COLUMN_CLAUSE = new RegExp(`^\\s*ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${IDENT}\\b`, 'i');
const CREATE_RELATION = new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?(?:TABLE|INDEX)\\s+IF\\s+NOT\\s+EXISTS\\s+${IDENT}\\b`, 'i');

/** The catalog objects an idempotent statement would create, or null when the
 * statement is not a plain IF NOT EXISTS create whose effect can be read back. */
export function satisfiedCheck(statement: string): { relation: string; columns: string[] } | null {
  const sql = statement.replace(/^(?:\s*--[^\n]*\n)*/, '').trim().replace(/;\s*$/, '');
  const create = sql.match(CREATE_RELATION);
  if (create && !/\bCONCURRENTLY\b/i.test(sql)) return { relation: create[1]!.toLowerCase(), columns: [] };
  const alter = sql.match(ADD_COLUMN);
  if (!alter) return null;
  const columns: string[] = [];
  for (const part of topLevelParts(alter[2]!)) {
    const column = part.match(COLUMN_CLAUSE);
    if (!column) return null;
    columns.push(column[1]!.toLowerCase());
  }
  return { relation: alter[1]!.toLowerCase(), columns };
}

/** True when an IF NOT EXISTS statement's objects already exist. Such a statement
 * is a no-op, but PostgreSQL still queues for the table lock to learn that, which
 * a busy production table can refuse. Reading the catalog takes no table lock. */
export async function alreadySatisfied(database: CatalogDatabase, statement: string): Promise<boolean> {
  const check = satisfiedCheck(statement);
  if (!check) return false;
  const { rows } = await database.query(
    `SELECT to_regclass($1) IS NOT NULL AS relation,
       (SELECT count(*)::int FROM pg_attribute
         WHERE attrelid = to_regclass($1) AND attname = ANY($2::text[]) AND NOT attisdropped) AS columns`,
    [check.relation, check.columns],
  );
  return rows[0]?.relation === true && rows[0]?.columns === check.columns.length;
}

const stripStatement = (statement: string) =>
  statement.replace(/^(?:\s*--[^\n]*\n)*/, '').trim().replace(/;\s*$/, '');
const DROP_TRIGGER = new RegExp(`^DROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+${IDENT}\\s+ON\\s+(?:ONLY\\s+)?${IDENT}$`, 'i');
const CREATE_TRIGGER = new RegExp(`^CREATE\\s+TRIGGER\\s+${IDENT}\\s[\\s\\S]*?\\bON\\s+${IDENT}\\s`, 'i');

/** Compare trigger definitions the way pg_get_triggerdef prints them. */
export function normalizeTriggerDefinition(sql: string): string {
  return stripStatement(sql)
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)/g, '$1')
    .replace(/\bEXECUTE\s+PROCEDURE\b/gi, 'EXECUTE FUNCTION')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .toLowerCase();
}

/** A drop-and-recreate trigger pair whose trigger already has exactly the new
 * definition, as [trigger, table], or null when the pair is anything else. */
export function triggerPair(drop: string, create: string): [string, string] | null {
  const dropped = stripStatement(drop).match(DROP_TRIGGER);
  const created = stripStatement(create).match(CREATE_TRIGGER);
  if (!dropped || !created) return null;
  const [trigger, table] = [dropped[1]!.toLowerCase(), dropped[2]!.toLowerCase()];
  return created[1]!.toLowerCase() === trigger && created[2]!.toLowerCase() === table ? [trigger, table] : null;
}

/** True when a DROP TRIGGER IF EXISTS / CREATE TRIGGER pair would recreate a
 * trigger identical to the installed one. Dropping it would still queue for a
 * lock on the (usually hot) table, so the pair is skipped. */
export async function triggerAlreadyCurrent(
  database: CatalogDatabase, drop: string, create: string,
): Promise<boolean> {
  const pair = triggerPair(drop, create);
  if (!pair) return false;
  const { rows } = await database.query(
    `SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = to_regclass($2) AND tgname = $1 AND NOT tgisinternal`,
    pair,
  );
  const installed = rows[0]?.definition;
  return typeof installed === 'string' && normalizeTriggerDefinition(installed) === normalizeTriggerDefinition(create);
}

const ALTER_TABLE = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${IDENT}\\s+([\\s\\S]+)$`, 'i');
const DROP_COLUMN = new RegExp(`^\\s*DROP\\s+COLUMN\\s+IF\\s+EXISTS\\s+${IDENT}\\s*$`, 'i');
const DROP_CONSTRAINT = new RegExp(`^\\s*DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${IDENT}\\s*$`, 'i');
const NOT_NULL = new RegExp(`^\\s*ALTER\\s+COLUMN\\s+${IDENT}\\s+(SET|DROP)\\s+NOT\\s+NULL\\s*$`, 'i');
const DROP_RELATION = new RegExp(`^DROP\\s+(?:TABLE|INDEX)\\s+IF\\s+EXISTS\\s+${IDENT}(?:\\s+CASCADE)?$`, 'i');

type AlterClause =
  | { kind: 'drop-column'; name: string }
  | { kind: 'drop-constraint'; name: string }
  | { kind: 'not-null'; name: string; notNull: boolean };

/** The catalog state that makes an ALTER TABLE / DROP statement a no-op, or null. */
export function noOpCheck(statement: string):
  | { kind: 'drop-relation'; relation: string }
  | { kind: 'alter'; relation: string; clauses: AlterClause[] }
  | null {
  const sql = stripStatement(statement);
  const drop = sql.match(DROP_RELATION);
  if (drop) return { kind: 'drop-relation', relation: drop[1]!.toLowerCase() };
  const alter = sql.match(ALTER_TABLE);
  if (!alter) return null;
  const clauses: AlterClause[] = [];
  for (const part of topLevelParts(alter[2]!)) {
    const column = part.match(DROP_COLUMN);
    const constraint = part.match(DROP_CONSTRAINT);
    const notNull = part.match(NOT_NULL);
    if (column) clauses.push({ kind: 'drop-column', name: column[1]!.toLowerCase() });
    else if (constraint) clauses.push({ kind: 'drop-constraint', name: constraint[1]!.toLowerCase() });
    else if (notNull) clauses.push({ kind: 'not-null', name: notNull[1]!.toLowerCase(), notNull: notNull[2]!.toUpperCase() === 'SET' });
    else return null;
  }
  return { kind: 'alter', relation: alter[1]!.toLowerCase(), clauses };
}

/** True when a drop or NOT NULL change has nothing left to do: the dropped
 * objects are absent and every column already has the requested nullability.
 * Like the IF NOT EXISTS skips, this reads the catalog without a table lock. */
export async function alreadyNoOp(database: CatalogDatabase, statement: string): Promise<boolean> {
  const trigger = stripStatement(statement).match(DROP_TRIGGER);
  if (trigger) {
    const { rows } = await database.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass($2) AND tgname = $1 AND NOT tgisinternal`,
      [trigger[1]!.toLowerCase(), trigger[2]!.toLowerCase()]);
    return rows.length === 0;
  }
  const check = noOpCheck(statement);
  if (!check) return false;
  const { rows: [table] } = await database.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [check.relation]);
  if (table?.present !== true)
    return check.kind === 'drop-relation' || /^ALTER\s+TABLE\s+IF\s+EXISTS\b/i.test(stripStatement(statement));
  if (check.kind === 'drop-relation') return false;
  for (const clause of check.clauses) {
    if (clause.kind === 'drop-constraint') {
      const { rows } = await database.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass($1) AND conname = $2`, [check.relation, clause.name]);
      if (rows.length) return false;
      continue;
    }
    const { rows } = await database.query(
      `SELECT attnotnull FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped`,
      [check.relation, clause.name]);
    if (clause.kind === 'not-null' ? rows[0]?.attnotnull !== clause.notNull : rows.length > 0) return false;
  }
  return true;
}
