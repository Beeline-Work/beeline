import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from "../../../tests/helpers/server.js";
import { BackgroundWork } from './background-work.js';
import { ConnectorOfferExpiryLoop, CONNECTOR_OFFER_DUE_KEY } from './connector-offer-expiry.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion, subscribeCommandCompletion } from './command-completion.js';
import type { SqlDatabase } from './database.js';

const human='a'.repeat(64), room='11111111-1111-4111-8111-111111111111', workspace='22222222-2222-4222-8222-222222222222';
describe('connector offer expiry obligations', () => {
  let db: PgliteDatabase, stop: () => Promise<void>;
  beforeAll(async () => {
    db=await migratedDatabase();
    stop=await db.client.listen(COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner')`,[human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`,[room,workspace]);
  },60000);
  afterAll(async()=>{await stop();await db.close();});

  it('empty queues perform no SQL on an idle day or unrelated wake',async()=>{
    let now=0;const query=vi.fn(db.query.bind(db));
    const observed:SqlDatabase={query,transaction:work=>work(observed)};
    const loop=new ConnectorOfferExpiryLoop(observed),work=new BackgroundWork(()=>now,()=>{});
    work.addDeadline('offers',()=>loop.runOnce());
    expect(await work.run(true)).toBe(Infinity);expect(query).toHaveBeenCalledTimes(2);
    now=86_400_000;work.wake('unrelated');expect(await work.run(false)).toBe(Infinity);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('only committed connecting deadlines and cancellations wake the owner',async()=>{
    const wake=vi.fn(),release=subscribeCommandCompletion(CONNECTOR_OFFER_DUE_KEY,wake);
    const id='33333333-3333-4333-8333-333333333333';
    try {
      await db.query(`INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id)
        VALUES($1,$2,$3,$4,$2,'trusty-squire','Synthetic','machine')`,[id,human,workspace,room]);
      expect(wake).not.toHaveBeenCalled();
      await db.query(`UPDATE connector_offers SET status='connecting',accepted_at=now() WHERE id=$1`,[id]);
      expect(wake).toHaveBeenCalledOnce();wake.mockClear();
      await db.query(`UPDATE connector_offers SET reason='Changed content' WHERE id=$1`,[id]);
      expect(wake).not.toHaveBeenCalled();
      await expect(db.transaction(async tx=>{
        await tx.query(`UPDATE connector_offers SET accepted_at=now()-interval '20 minutes' WHERE id=$1`,[id]);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(wake).not.toHaveBeenCalled();
      const delay=await new ConnectorOfferExpiryLoop(db).runOnce();
      expect(delay).toBeGreaterThan(14*60_000);expect(delay).toBeLessThanOrEqual(15*60_000);
      await db.query(`UPDATE connector_offers SET status='accepted' WHERE id=$1`,[id]);
      expect(wake).toHaveBeenCalledOnce();
      expect(await new ConnectorOfferExpiryLoop(db).runOnce()).toBeUndefined();
    } finally {release();}
  });

  it('failed observation parks without a deadline until an actual source wake',async()=>{
    let now=0;const query=vi.fn().mockRejectedValueOnce(new Error('outage')).mockResolvedValue({rows:[],rowCount:0});
    const db:SqlDatabase={query,transaction:work=>work(db)};
    const loop=new ConnectorOfferExpiryLoop(db),work=new BackgroundWork(()=>now,()=>{});
    work.addDeadline('offers',async()=>{try{return await loop.runOnce();}catch{return;}});
    expect(await work.run(true)).toBe(Infinity);expect(query).toHaveBeenCalledOnce();
    now=86_400_000;expect(await work.run(false)).toBe(Infinity);expect(query).toHaveBeenCalledOnce();
    work.wake('offers','committed-offer');expect(await work.run(false)).toBe(Infinity);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
