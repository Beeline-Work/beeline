import type { SqlDatabase } from './database.js';
import { commandArgumentDigest } from './router-command-ledger.js';
import { notifyCommittedCommand } from './postgres-live.js';
import { notifyCommandCompletion, subscribeCommandCompletion } from './command-completion.js';

type Result = Record<string, unknown>;
const operation = 'helper-request';

/** Request ids survive socket replacement. Admission commits before dispatch;
 * a reconnect only observes the original execution, including while it runs.
 * Results have no expiry until the helper acknowledges delivery. */
export class MachineRequestResults {
  constructor(private readonly database: SqlDatabase) {}
  async execute(agentId: string, requestId: string, input: unknown, run: () => Promise<Result>): Promise<Result | undefined> {
    const digest = commandArgumentDigest(operation,input);
    const claimed = await this.database.query(`INSERT INTO router_commands(principal,operation,command_id,digest,state)
      VALUES($1,$2,$3,$4,'pending') ON CONFLICT(principal,operation,command_id) DO NOTHING RETURNING command_id`,
      [agentId,operation,requestId,digest]);
    if (!claimed.rowCount) {
      const row = (await this.database.query<{digest:string}>(`SELECT digest FROM router_commands
        WHERE principal=$1 AND operation=$2 AND command_id=$3`,[agentId,operation,requestId])).rows[0];
      if (row?.digest !== digest) return {error:'request_identity_conflict',status:409};
      return this.read(agentId,requestId);
    }
    const result = await run();
    const key = {principal:agentId,operation,commandId:requestId};
    await this.database.transaction(async db => {
      await db.query(`UPDATE router_commands SET state='committed',result=$4::jsonb,completed_at=now()
        WHERE principal=$1 AND operation=$2 AND command_id=$3`,[agentId,operation,requestId,JSON.stringify(result)]);
      await notifyCommittedCommand(db,key);
    });
    notifyCommandCompletion(key);
    return result;
  }
  read(agentId:string,requestId:string,signal?:AbortSignal):Promise<Result|undefined> {
    return new Promise((resolve,reject) => {
      let reading=false,dirty=false,ended=false;
      const finish=(error?:unknown,result?:Result) => {
        if(ended)return;ended=true;release();signal?.removeEventListener('abort',abort);
        if(error)reject(error);else resolve(result);
      };
      const abort=()=>finish(undefined);
      const inspect=async()=>{
        dirty=true;if(reading||ended)return;reading=true;
        try {
          do {
            dirty=false;
            const row=(await this.database.query<{state:string;result:Result|null}>(`SELECT state,result FROM router_commands
              WHERE principal=$1 AND operation=$2 AND command_id=$3`,[agentId,operation,requestId])).rows[0];
            if(!row){finish(undefined);return;}
            if(row.state==='committed'){finish(undefined,row.result??{});return;}
          }while(dirty&&!ended);
        }catch(error){finish(error);}finally{reading=false;}
      };
      const release=subscribeCommandCompletion({principal:agentId,operation,commandId:requestId},()=>{void inspect();});
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();else void inspect();
    });
  }
  async acknowledge(agentId:string,requestId:string):Promise<void> {
    // Keep the identity fence; compaction may reclaim acknowledged payloads.
    await this.database.query(`UPDATE router_commands SET result_expires_at=now()
      WHERE principal=$1 AND operation=$2 AND command_id=$3 AND state='committed'`,[agentId,operation,requestId]);
  }
}
