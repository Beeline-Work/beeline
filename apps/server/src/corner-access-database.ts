import type { QueryResultRow } from 'pg';
import type { QueryResult, SqlDatabase } from './database.js';

/** Keep reviewed message statements intact while resolving their membership reads at execution. */
export class CornerAccessDatabase implements SqlDatabase {
  constructor(private readonly database: SqlDatabase) {
    if (database instanceof CornerAccessDatabase) this.database = database.database;
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
    return this.database.query<Row>(new CornerAccessStatement(sql).sql, values);
  }

  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.database.transaction(database => work(new CornerAccessDatabase(database)));
  }
}

/** Resolve access reads outside owner-reviewed message query templates. */
export class CornerAccessStatement {
  readonly sql: string;
  constructor(sql: string) {
    // Locking statements must use stored parent memberships.
    const locked = /\bFOR\s+(?:(?:NO\s+KEY|KEY)\s+)?(?:UPDATE|SHARE)\b/i.test(sql);
    const aliases = [...sql.matchAll(/\b(?:FROM|JOIN)\s+memberships\s+(\w+)/gi)].map(match => match[1]!);
    const locksMember = locked && aliases.some(alias =>
      new RegExp('\\bFOR\\s+(?:(?:NO\\s+KEY|KEY)\\s+)?(?:UPDATE|SHARE)\\s+OF\\s+[^;\\n]*\\b' + alias + '\\b', 'i').test(sql));
    if (locksMember || (locked && !/\b(?:UPDATE|SHARE)\s+OF\b/i.test(sql))) {
      // These statements must lock stored rows, so resolve the parent key instead of a UNION view.
      for (const alias of aliases) {
        sql = sql.replace(new RegExp('\\b' + alias + '\\.room_id\\s*=\\s*([\\w.$]+)(?=\\s|$|[,\\)])', 'g'),
          (_match, roomId: string) => `${alias}.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=${roomId})`);
      }
      this.sql = sql;
      return;
    }
    // Quoted values and comments are opaque. Values supplied by callers remain bound parameters.
    const tokens = /'(?:''|\\.|[^'\\])*'|"(?:""|[^"])*"|\$([A-Za-z_][A-Za-z_0-9]*|)\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\/|\bDELETE\s+FROM\s+memberships\b|\b(?:FROM|JOIN)\s+memberships\b/gi;
    this.sql = sql.replace(tokens, token =>
      /^(?:FROM|JOIN)\s+memberships$/i.test(token)
        ? token.replace(/memberships$/i, 'effective_memberships') : token);
  }
}
