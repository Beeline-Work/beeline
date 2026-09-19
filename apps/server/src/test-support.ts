import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import type { QueryResultRow } from 'pg';
import type { SqlDatabase, QueryResult } from './database.js';
import type { ObjectStorage } from './object-storage.js';

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

/**
 * In-process object storage for tests: put/get/delete against a map, and a
 * tiny HTTP server so a 302 from `/v1/media/<id>` can follow to real bytes.
 */
export class MemoryObjectStorage {
  readonly blobs = new Map<string, { bytes: Buffer; type: string }>();
  #server?: Server;
  #origin = '';

  get origin(): string {
    return this.#origin;
  }

  asStorage(): ObjectStorage {
    return this as unknown as ObjectStorage;
  }

  async listen(): Promise<string> {
    this.#server = createServer((request, response) => {
      const key = decodeURIComponent((request.url ?? '/').slice(1));
      const blob = this.blobs.get(key);
      if (!blob) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': blob.type,
        'content-length': String(blob.bytes.length),
      });
      response.end(blob.bytes);
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    const address = this.#server.address() as AddressInfo;
    this.#origin = `http://127.0.0.1:${address.port}`;
    return this.#origin;
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) =>
      this.#server!.close((error) => (error ? reject(error) : resolve())),
    );
    this.#server = undefined;
  }

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.blobs.set(key, { bytes: Buffer.from(body), type: contentType });
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    const blob = this.blobs.get(key);
    return blob ? new Uint8Array(blob.bytes) : null;
  }

  presignPost(): { url: string; fields: Record<string, string> } {
    return { url: `${this.#origin}/post`, fields: {} };
  }

  async presignGet(key: string): Promise<string> {
    return `${this.#origin}/${encodeURIComponent(key)}`;
  }

  async headObject(key: string): Promise<{ size: number } | null> {
    const blob = this.blobs.get(key);
    return blob ? { size: blob.bytes.length } : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}
