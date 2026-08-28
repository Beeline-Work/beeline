import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { isRoomHistoryView, isRoomView } from '@beeline/buzz-client';
import { migrateRoomReadMarks, type DatabaseQueryable } from './database.js';
import corpus from './fixtures/production-room-events-2026-08.json';
import { RoomIndexer } from './room-indexer.js';

const TENANT = 'e8299f28-f095-472f-941a-80d1195b9a24';
const WORKSPACE = 'ec08be9d-9d9d-413e-b546-959d4abe39df';
const ROOM = '7d111868-52eb-43ab-98ae-8a6c49b92da8';

function hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

function uuid(value: string): string {
  const valueHex = hex(value);
  return `${valueHex.slice(0, 8)}-${valueHex.slice(8, 12)}-4${valueHex.slice(13, 16)}-8${valueHex.slice(17, 20)}-${valueHex.slice(20, 32)}`;
}

describe('PRODUCTION-CORPUS REPLAY gate — server-indexed Room surfaces', () => {
  it('indexes every displayable row from the sanitized production capture into guarded pages', async () => {
    expect(corpus.capture.source).toContain('production-read-only-query');
    expect(corpus.events).toHaveLength(corpus.capture.eventCount);
    const shapeHash = createHash('sha256')
      .update(
        JSON.stringify(
          corpus.events.map(({ kind, tags, shape }) => ({
            kind,
            tagArities: tags.map((tag) => tag.length),
            tagNames: tags.map((tag) => tag[0]),
            shape,
          })),
        ),
      )
      .digest('hex');
    expect(shapeHash).toBe(corpus.capture.shapeHash);

    const postgres = new PGlite();
    const database: DatabaseQueryable = {
      query: async <Row>(text: string, values?: unknown[]) => {
        const result = await postgres.query<Row>(text, values as never[] | undefined);
        return { rows: result.rows };
      },
    };
    try {
      await postgres.exec(`
        CREATE TABLE channels (
          community_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL,
          description text, visibility text NOT NULL DEFAULT 'open', created_by bytea NOT NULL,
          created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
          archived_at timestamptz, deleted_at timestamptz,
          PRIMARY KEY (community_id, id)
        );
        CREATE TABLE channel_members (
          community_id uuid NOT NULL, channel_id uuid NOT NULL, pubkey bytea NOT NULL,
          role text NOT NULL, removed_at timestamptz
        );
        CREATE TABLE users (
          community_id uuid NOT NULL, pubkey bytea NOT NULL, display_name text,
          nip05_handle text, avatar_url text, deactivated_at timestamptz
        );
        CREATE TABLE events (
          community_id uuid NOT NULL, id bytea NOT NULL, pubkey bytea NOT NULL,
          created_at timestamptz NOT NULL, kind integer NOT NULL, tags jsonb NOT NULL,
          content text NOT NULL, d_tag text, channel_id uuid, deleted_at timestamptz
        );
      `);
      await migrateRoomReadMarks(database);

      const actors = Object.fromEntries(
        corpus.actors.map((actor) => [actor.alias, hex(`production-corpus:${actor.alias}`)]),
      );
      const viewerAlias = corpus.actors.find((actor) => actor.kind === 'human')!.alias;
      const viewerPubkey = actors[viewerAlias]!;
      await postgres.query(
        `INSERT INTO channels
          (community_id, id, name, visibility, created_by, created_at, updated_at)
         VALUES
          ($1, $2, 'Captured Workspace', 'private', $4, to_timestamp(1), to_timestamp(844)),
          ($1, $3, 'Captured Room', 'open', $4, to_timestamp(1), to_timestamp(844))`,
        [TENANT, WORKSPACE, ROOM, bytes(viewerPubkey)],
      );

      for (const actor of corpus.actors) {
        const pubkey = actors[actor.alias]!;
        await postgres.query(
          `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
           VALUES ($1, $2, $4, $5), ($1, $3, $4, $5)`,
          [TENANT, WORKSPACE, ROOM, bytes(pubkey), actor.alias === viewerAlias ? 'owner' : 'member'],
        );
        await postgres.query(
          `INSERT INTO users (community_id, pubkey, display_name)
           VALUES ($1, $2, $3)`,
          [TENANT, bytes(pubkey), `Captured ${actor.kind} ${actor.alias}`],
        );
      }

      const insertEvent = async (
        id: string,
        pubkey: string,
        createdAt: number,
        kind: number,
        tags: readonly (readonly string[])[],
        content: string,
        channelId: string,
      ) => {
        await postgres.query(
          `INSERT INTO events
            (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
           VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9)`,
          [
            TENANT,
            bytes(id),
            bytes(pubkey),
            createdAt,
            kind,
            JSON.stringify(tags),
            content,
            channelId,
            tags.find((tag) => tag[0] === 'd')?.[1] ?? null,
          ],
        );
      };
      await insertEvent(
        hex('captured-workspace-generation'),
        viewerPubkey,
        1,
        9007,
        [
          ['h', WORKSPACE],
          ['community', WORKSPACE],
          ['name', 'Captured Workspace'],
        ],
        '',
        WORKSPACE,
      );
      await insertEvent(
        hex('captured-room-generation'),
        viewerPubkey,
        1,
        9007,
        [
          ['h', ROOM],
          ['community', WORKSPACE],
          ['name', 'Captured Room'],
        ],
        '',
        ROOM,
      );
      for (const actor of corpus.actors.filter((candidate) => candidate.kind === 'agent')) {
        await insertEvent(
          hex(`captured-agent:${actor.alias}`),
          actors[actor.alias]!,
          1,
          9,
          [
            ['h', WORKSPACE],
            ['t', 'buzz-agent'],
          ],
          JSON.stringify({ displayName: `Captured agent ${actor.alias}` }),
          WORKSPACE,
        );
      }

      const eventIds = Object.fromEntries(
        corpus.events.map((event) => [event.alias, hex(`production-event:${event.alias}`)]),
      );
      const substitute = (value: string): string => {
        if (value === '$room') return ROOM;
        if (value === '$workspace') return WORKSPACE;
        if (actors[value]) return actors[value]!;
        if (eventIds[value]) return eventIds[value]!;
        if (value.startsWith('$event') || value.startsWith('$externalEvent')) return hex(value);
        if (value.startsWith('$channel')) return uuid(value);
        if (value.startsWith('$person')) return hex(value);
        return value;
      };
      const values: unknown[] = [];
      const tuples = corpus.events.map((event) => {
        const offset = values.length;
        values.push(
          TENANT,
          bytes(eventIds[event.alias]!),
          bytes(actors[event.actor]!),
          event.created_at,
          event.kind,
          JSON.stringify(event.tags.map((tag) => tag.map(substitute))),
          event.content,
          ROOM,
        );
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, to_timestamp($${offset + 4}), $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
      });
      await postgres.query(
        `INSERT INTO events
          (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
         VALUES ${tuples.join(', ')}`,
        values,
      );

      const indexer = new RoomIndexer(database);
      const replayStartedAt = performance.now();
      const room = await indexer.readRoom(ROOM, viewerPubkey);
      expect(isRoomView(room)).toBe(true);

      const messages = new Map<string, string>();
      let before: { createdAt: number; id: string } | undefined;
      let pageCount = 0;
      do {
        const page = await indexer.readHistory(ROOM, viewerPubkey, before);
        expect(isRoomHistoryView(page)).toBe(true);
        for (const message of page!.messages) messages.set(message.id, message.text);
        before = page!.nextBefore;
        pageCount += 1;
        expect(pageCount).toBeLessThan(30);
      } while (before);

      const replayElapsedMs = performance.now() - replayStartedAt;
      expect(messages.size).toBeGreaterThanOrEqual(corpus.expected.minimumTranscriptItems);
      expect(messages.size).toBe(corpus.expected.serverProjectedMessages);
      expect(replayElapsedMs).toBeLessThan(corpus.expected.maximumReplayMs);
      expect([...messages.values()].some((text) => text.includes('Captured production'))).toBe(true);
      const controlText = new Set(
        corpus.events
          .filter((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'body-control'))
          .map((event) => event.content),
      );
      expect([...messages.values()].filter((text) => controlText.has(text))).toEqual([]);
    } finally {
      await postgres.close();
    }
  });
});
