import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Messaging } from 'firebase-admin/messaging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseEventReader,
  PostgresReservationPersistence,
  migrateMaterializerReservations,
  type DatabaseQueryable,
} from './database.js';
import { DeliveryState } from './delivery-state.js';
import { PushGateway } from './gateway.js';
import { TokenRegistry } from './registry.js';

const COMMUNITY = 'e8299f28-f095-472f-941a-80d1195b9a24';
const MEMBER_ROOM = '9b929b0d-5189-4dbf-b6ba-a9f4ddf81bc6';
const OTHER_ROOM = '3f37b271-1a12-4d2a-b002-202b3f3582b9';
const MEMBER = 'a'.repeat(64);
const OUTSIDER = 'b'.repeat(64);
const AUTHOR = 'c'.repeat(64);

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

describe('shared materializer reservation store', () => {
  it('keeps consumer documents independent in one Postgres store', async () => {
    const postgres = new PGlite();
    const database: DatabaseQueryable = {
      query: async <Row>(text: string, values?: unknown[]) => {
        const result = await postgres.query(text, values as never[] | undefined);
        return { rows: result.rows as Row[] };
      },
    };
    try {
      await migrateMaterializerReservations(database);
      const push = new PostgresReservationPersistence(database, 'push-delivery');
      const events = new PostgresReservationPersistence(database, 'repository-events');
      await push.save({ version: 1, attempts: ['push-1'] });
      await events.save({ version: 1, pending: ['event-1'] });

      await expect(push.load()).resolves.toEqual({ version: 1, attempts: ['push-1'] });
      await expect(events.load()).resolves.toEqual({ version: 1, pending: ['event-1'] });
      const rows = await database.query<{ consumer: string }>(
        `SELECT consumer FROM beeline_materializer_reservations ORDER BY consumer`,
      );
      expect(rows.rows.map((row) => row.consumer)).toEqual(['push-delivery', 'repository-events']);
    } finally {
      await postgres.close();
    }
  });

  it('imports a legacy reservation document once without overwriting current state', async () => {
    const postgres = new PGlite();
    const database: DatabaseQueryable = {
      query: async <Row>(text: string, values?: unknown[]) => {
        const result = await postgres.query(text, values as never[] | undefined);
        return { rows: result.rows as Row[] };
      },
    };
    const directory = await mkdtemp(join(tmpdir(), 'materializer-reservations-'));
    const legacy = join(directory, 'deliveries.json');
    await writeFile(legacy, JSON.stringify({ version: 1, cursor: 7 }));
    try {
      await migrateMaterializerReservations(database);
      const first = new PostgresReservationPersistence(database, 'push-delivery', legacy);
      await expect(first.load()).resolves.toEqual({ version: 1, cursor: 7 });
      await first.save({ version: 1, cursor: 8 });
      await writeFile(legacy, JSON.stringify({ version: 1, cursor: 99 }));
      const restarted = new PostgresReservationPersistence(database, 'push-delivery', legacy);
      await expect(restarted.load()).resolves.toEqual({ version: 1, cursor: 8 });
    } finally {
      await postgres.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('DatabaseEventReader', () => {
  let postgres: PGlite;
  let database: DatabaseQueryable;

  beforeEach(async () => {
    postgres = new PGlite();
    database = {
      query: async <Row>(text: string, values?: unknown[]) => {
        const result = await postgres.query(text, values as never[] | undefined);
        return { rows: result.rows as Row[] };
      },
    };
    await postgres.exec(`
      CREATE TABLE channel_members (
        community_id uuid NOT NULL,
        channel_id uuid NOT NULL,
        pubkey bytea NOT NULL,
        removed_at timestamptz
      );
      CREATE TABLE channels (
        community_id uuid NOT NULL,
        id uuid NOT NULL,
        visibility text NOT NULL,
        deleted_at timestamptz
      );
      CREATE TABLE events (
        community_id uuid NOT NULL,
        id bytea NOT NULL,
        pubkey bytea NOT NULL,
        created_at timestamptz NOT NULL,
        kind integer NOT NULL,
        tags jsonb NOT NULL,
        content text NOT NULL,
        sig bytea NOT NULL,
        channel_id uuid,
        deleted_at timestamptz
      );
    `);
    await postgres.query(
      `INSERT INTO channels (community_id, id, visibility)
       VALUES ($1, $2, 'private'), ($1, $3, 'private'), ($1, $1, 'open')`,
      [COMMUNITY, MEMBER_ROOM, OTHER_ROOM],
    );
    await postgres.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1, $2, $3)`,
      [COMMUNITY, MEMBER_ROOM, bytes(MEMBER)],
    );
    await postgres.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       VALUES
         ($1, $2, $3, to_timestamp(101), 9, $4, 'member message', $5, $6),
         ($1, $7, $3, to_timestamp(102), 9, $8, 'other message', $5, $9),
         ($1, $10, $3, to_timestamp(99), 9007, $11, '', $5, $6),
         ($1, $12, $3, to_timestamp(98), 9007, $13, '', $5, $14)`,
      [
        COMMUNITY,
        bytes('1'.repeat(64)),
        bytes(AUTHOR),
        JSON.stringify([
          ['h', MEMBER_ROOM],
          ['p', MEMBER],
        ]),
        bytes('d'.repeat(128)),
        MEMBER_ROOM,
        bytes('2'.repeat(64)),
        JSON.stringify([['h', OTHER_ROOM]]),
        OTHER_ROOM,
        bytes('3'.repeat(64)),
        JSON.stringify([
          ['h', MEMBER_ROOM],
          ['community', COMMUNITY],
          ['name', 'Product Room'],
        ]),
        bytes('4'.repeat(64)),
        JSON.stringify([
          ['h', COMMUNITY],
          ['community', COMMUNITY],
          ['name', 'Product Workspace'],
        ]),
        COMMUNITY,
      ],
    );
  });

  afterEach(async () => {
    await postgres.close();
  });

  it('tails a real member-scoped row and excludes the same row from a non-member', async () => {
    const filters = [{ kinds: [9], since: 100, limit: 1_000 }];
    const memberEvents = await new DatabaseEventReader(database, MEMBER).query(filters);
    const outsiderEvents = await new DatabaseEventReader(database, OUTSIDER).query(filters);

    expect(memberEvents.map((event) => event.content)).toEqual(['member message']);
    expect(outsiderEvents).toEqual([]);
  });

  it('binds metadata reads to the candidate row community without a relay hostname', async () => {
    const reader = new DatabaseEventReader(database, MEMBER);
    const [message] = await reader.query([{ kinds: [9], since: 100, limit: 10 }]);
    expect(message).toBeDefined();

    const metadata = await reader
      .forEvent(message!)
      .query([{ kinds: [9007], '#h': [MEMBER_ROOM], limit: 5 }]);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.tags).toContainEqual(['community', COMMUNITY]);
  });

  it('carries a database-fed member mention through a notify decision and FCM send', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(MEMBER, 'fcm-token-member_12345678901234567890');
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'database-proof' }],
    }));
    const logs: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((line: unknown) => logs.push(String(line)));
    try {
      const reader = new DatabaseEventReader(database, MEMBER);
      const [message] = await reader.query([{ kinds: [9], since: 100, limit: 10 }]);
      expect(message).toBeDefined();
      const gateway = new PushGateway(
        registry,
        { sendEachForMulticast } as unknown as Messaging,
        await DeliveryState.load(),
      );

      await gateway.handleRelayEvent(message!, MEMBER, reader.forEvent(message!));

      expect(sendEachForMulticast).toHaveBeenCalledOnce();
      expect(logs).toContainEqual(expect.stringContaining('verdict=notify reason=fcm-result'));
    } finally {
      log.mockRestore();
    }
  });
});
