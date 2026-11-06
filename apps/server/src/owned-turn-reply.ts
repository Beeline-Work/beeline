import type {HelperTurnOwnershipSource} from '@beeline/api-contract/helper-turn-ownership';
import type {SqlDatabase} from './database.js';
import {ownedRoomAccessSql} from './turn-ownership.js';

/** One current source/access cut, retained only through synchronous transport enqueue. */
export async function fenceOwnedTurnReply(
  database:SqlDatabase,agentId:string,source:HelperTurnOwnershipSource,
  input:{roomId:string;generationId?:string;commandId?:string;requestId?:string},
  enqueue:()=>void,requireClaimed=false,
):Promise<void>{
    await database.transaction(async db => {
      const command = await db.query(`SELECT command.id FROM agent_commands command
        JOIN agent_connections connection ON connection.agent_id=command.agent_id
        JOIN live_server_instances server ON server.instance_id=connection.instance_id
        WHERE command.room_id=$1 AND command.agent_id=$2
          AND (($6::text IS NOT NULL AND command.id=$6) OR ($7::text IS NOT NULL AND command.turn_request_id=$7))
          AND command.generation_id=$3 AND command.turn_owner_connection_id=$4 AND command.turn_owner_epoch=$5
          AND command.state IN ('claimed','complete','cancelled') AND (NOT $8::boolean OR command.state='claimed')
          AND COALESCE(connection.turn_connection_id,connection.connection_id)=$4
          AND COALESCE(connection.turn_connection_epoch,connection.epoch)=$5 AND connection.released_at IS NULL
          AND server.renewed_at>clock_timestamp()-interval '90 seconds'
          AND EXISTS(${ownedRoomAccessSql('$1','$2','$6',true)})
        FOR SHARE OF command,connection NOWAIT`,
        [input.roomId, agentId, input.generationId ?? null, source.connectionId, source.epoch,
          input.commandId ?? null, input.requestId ?? null, requireClaimed]);
      if (!command.rowCount) throw new Error('Turn ownership source changed before enqueue');
      enqueue();
    });
}
