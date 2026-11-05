import { AsyncLocalStorage } from 'node:async_hooks';
import type { QueryResultRow } from 'pg';
import type { SqlDatabase } from './database.js';

/** Only explicitly audited DB-only command adapters install this scope. Never
 * hold an app transaction open over an external provider call. Each concurrent
 * request gets its own context; no mutable service-wide database swapping. */
export class CommandScopedDatabase implements SqlDatabase {
  private readonly scope = new AsyncLocalStorage<SqlDatabase>();
  constructor(private readonly base: SqlDatabase) {}
  run<T>(database: SqlDatabase, work: () => Promise<T>): Promise<T> { return this.scope.run(database, work); }
  get active(): boolean { return this.scope.getStore() !== undefined; }
  get backgroundWork() { return this.base.backgroundWork; }
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[], preparedName?: string) {
    return (this.scope.getStore() ?? this.base).query<Row>(sql, values, preparedName);
  }
  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return (this.scope.getStore() ?? this.base).transaction(work);
  }
}
