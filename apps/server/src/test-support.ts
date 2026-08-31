import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import type { QueryResultRow } from 'pg';
import type { SqlDatabase, QueryResult } from './database.js';

export class PgliteDatabase implements SqlDatabase {
  constructor(readonly client: PGliteInterface = new PGlite()) {}
  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (!values.length && sql.split(';').filter((part) => part.trim()).length > 1) {
      await this.client.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const result = values.length
      ? await this.client.query<Row>(sql, values)
      : await this.client.query<Row>(sql);
    return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) };
  }
  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction) => work(this.executor(transaction)));
  }
  close() {
    return this.client.close();
  }
  private executor(transaction: Transaction): SqlDatabase {
    return {
      query: async <Row extends QueryResultRow = QueryResultRow>(
        sql: string,
        values: unknown[] = [],
      ) => {
        if (!values.length && sql.split(';').filter((part) => part.trim()).length > 1) {
          await transaction.exec(sql);
          return { rows: [], rowCount: 0 };
        }
        const result = values.length
          ? await transaction.query<Row>(sql, values)
          : await transaction.query<Row>(sql);
        return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) };
      },
      transaction: async <T>(work: (database: SqlDatabase) => Promise<T>) =>
        work(this.executor(transaction)),
    };
  }
}
