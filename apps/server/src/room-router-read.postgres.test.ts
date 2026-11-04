import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  groupAFixture,
  ObservedDatabase,
  reader,
  workspace,
  room,
} from '../proofs/router-group-a-postgres.js';
import { PhoneService } from './phone-service.js';
import type { SqlDatabase } from './database.js';
import { buildRouterSnapshot, fenceRouterEnqueue } from './router-projections.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
const input = { family: 'room-head' as const, roomId: room(), workspaceId: workspace() };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe.skipIf(!url)(
  'F13 single-statement Room data, authority and cut on real PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof groupAFixture>>;
    beforeAll(async () => {
      fixture = await groupAFixture(url!);
    }, 120_000);
    afterAll(async () => {
      await fixture?.close();
    });
    it('matches the generic same-cut snapshot while using only isolation plus one SELECT', async () => {
      const observed = new ObservedDatabase(fixture.a),
        phone = new PhoneService(observed, 'https://synthetic.invalid');
      const actual = await phone.readRouterSnapshot(input, reader);
      expect(observed.statements).toHaveLength(2);
      expect(observed.statements[0]!.sql).toBe(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      expect(observed.statements[1]!.sql.trimStart().startsWith('WITH authorized_room')).toBe(true);
      const generic = await buildRouterSnapshot(fixture.a, input, reader, (tx, args, viewer) =>
        phone.buildRouterValue(tx, args, viewer),
      );
      expect(actual).toEqual(generic);
      await expect(
        phone.readRouterSnapshot({ ...input, workspaceId: workspace(2) }, reader),
      ).rejects.toMatchObject({ reason: 'authority' });
      await expect(phone.readRouterSnapshot(input, 'unrelated-reader')).rejects.toMatchObject({
        reason: 'authority',
      });
    });
    it('preserves legacy root and corner enrichment without a separate read', async () => {
      const corner = room(99),
        media = '99999999-9999-4999-8999-999999999999';
      await fixture.a.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Enriched corner',$3)`,
        [corner, workspace(), room()],
      );
      await fixture.a.query(`INSERT INTO object_expirations(id) VALUES($1)`, [media]);
      for (const target of [room(), corner]) {
        const id = target.replaceAll('-', '').padEnd(64, 'f');
        await fixture.a.query(
          `INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'Preserved prose',$4::jsonb)`,
          [
            id,
            target,
            reader,
            JSON.stringify([
              {
                kind: 'file',
                name: 'Expired file',
                url: `https://synthetic.invalid/v1/media/${media}?download=1`,
                mimeType: 'text/plain',
                size: 12,
              },
            ]),
          ],
        );
        await fixture.a.query(
          `INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
        VALUES($1,$2,$3,$4,'Enrichment fixture',$5,now())`,
          [reader, workspace(), target, id, target === corner ? 'corner' : 'room'],
        );
        await fixture.a.query(
          `INSERT INTO feedback_items(id,source_kind,reporter_identity_id,workspace_id,room_id,trigger_message_id,category,summary,summary_key)
        VALUES($1,'human',$2,$3,$4,$1,'human_report','Fixture','fixture')`,
          [id, reader, workspace(), target],
        );
        const service = new PhoneService(fixture.a, 'https://synthetic.invalid');
        const legacy = await service.readRoom(target, reader);
        const observed = new ObservedDatabase(fixture.a);
        const candidate = await new PhoneService(
          observed,
          'https://synthetic.invalid',
        ).readRouterSnapshot({ ...input, roomId: target }, reader);
        expect(candidate.value).toEqual(legacy);
        expect(candidate.value).toMatchObject({
          messages: [
            {
              id,
              text: 'Preserved prose',
              bookmarked: true,
              feedbackReported: true,
              attachments: [{ expired: true }],
            },
          ],
        });
        expect(observed.statements).toHaveLength(2);
      }
    });
    it('never relabels a fetched Room/authority/enrichment tuple with a later writer cut', async () => {
      const captured = deferred(),
        release = deferred();
      let pending: ReturnType<PhoneService['readRouterSnapshot']> | undefined;
      const before = await new PhoneService(
        fixture.a,
        'https://synthetic.invalid',
      ).readRouterSnapshot(input, reader);
      const wrap = (db: SqlDatabase): SqlDatabase => ({
        transaction: (work) => db.transaction((tx) => work(wrap(tx))),
        query: async (sql, args) => {
          const result = await db.query(sql, args);
          if (sql.includes('router_metadata')) {
            captured.resolve();
            await release.promise;
          }
          return result;
        },
      });
      try {
        pending = new PhoneService(wrap(fixture.a), 'https://synthetic.invalid').readRouterSnapshot(
          input,
          reader,
        );
        await captured.promise;
        await fixture.b.query(`UPDATE rooms SET name='Committed after SELECT' WHERE id=$1`, [
          input.roomId,
        ]);
        release.resolve();
        expect(await pending).toEqual(before);
        const after = await new PhoneService(
          fixture.b,
          'https://synthetic.invalid',
        ).readRouterSnapshot(input, reader);
        expect(after.value).toMatchObject({ room: { name: 'Committed after SELECT' } });
        expect(after.cut.through).toBeGreaterThan(before.cut.through);
      } finally {
        release.resolve();
        await pending?.catch(() => {});
      }
    });
    it('keeps the current READ COMMITTED enqueue fence after the optimized build', async () => {
      const phone = new PhoneService(fixture.a, 'https://synthetic.invalid'),
        snapshot = await phone.readRouterSnapshot(input, reader);
      const captured = deferred(),
        release = deferred();
      let pending: Promise<void> | undefined,
        enqueued = 0;
      const wrap = (db: SqlDatabase): SqlDatabase => ({
        transaction: (work) => db.transaction((tx) => work(wrap(tx))),
        query: async (sql, args) => {
          const result = await db.query(sql, args);
          if (sql.includes('pg_advisory_xact_lock_shared')) {
            captured.resolve();
            await release.promise;
          }
          return result;
        },
      });
      try {
        pending = fenceRouterEnqueue(wrap(fixture.a), input, reader, snapshot.authority, () => {
          enqueued++;
          return undefined;
        });
        await captured.promise;
        await expect(
          fixture.b.transaction(async (tx) => {
            await tx.query("SET LOCAL lock_timeout='100ms'");
            await tx.query(
              'UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',
              [input.roomId, reader],
            );
          }),
        ).rejects.toMatchObject({ code: '55P03' });
        expect(enqueued).toBe(0);
        release.resolve();
        await pending;
        expect(enqueued).toBe(1);
        await fixture.b.query(
          'UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',
          [input.roomId, reader],
        );
        await expect(
          fenceRouterEnqueue(fixture.a, input, reader, snapshot.authority, () => {
            enqueued++;
            return undefined;
          }),
        ).rejects.toMatchObject({ reason: 'authority' });
        expect(enqueued).toBe(1);
      } finally {
        release.resolve();
        await pending?.catch(() => {});
        await fixture.b.query(
          'UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2',
          [input.roomId, reader],
        );
      }
    });
    it('refuses a missing certificate without inventing an epoch', async () => {
      const scope = `reader:${reader}:workspace:${input.workspaceId}`;
      const epoch = (
        await fixture.a.query<{ epoch: string }>(
          'DELETE FROM router_authority WHERE scope=$1 RETURNING epoch::text',
          [scope],
        )
      ).rows[0]!.epoch;
      try {
        await expect(
          new PhoneService(fixture.a, 'https://synthetic.invalid').readRouterSnapshot(
            input,
            reader,
          ),
        ).rejects.toMatchObject({ reason: 'authority' });
      } finally {
        await fixture.a.query('INSERT INTO router_authority(scope,epoch) VALUES($1,$2)', [
          scope,
          epoch,
        ]);
      }
    });
    it('refuses an uninitialized stream without writing a new head', async () => {
      await fixture.a.query('DELETE FROM live_journal WHERE stream_id=$1', [
        `workspace:${input.workspaceId}`,
      ]);
      await fixture.a.query('DELETE FROM live_streams WHERE id=$1', [
        `workspace:${input.workspaceId}`,
      ]);
      await expect(
        new PhoneService(fixture.a, 'https://synthetic.invalid').readRouterSnapshot(input, reader),
      ).rejects.toMatchObject({ reason: 'dependency' });
      expect(
        (
          await fixture.a.query('SELECT 1 FROM live_streams WHERE id=$1', [
            `workspace:${input.workspaceId}`,
          ])
        ).rowCount,
      ).toBe(0);
    });
  },
);
