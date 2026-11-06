import { Client } from 'pg';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from '../command-completion.js';

/** Direct service tests need the same committed completion events as the server. */
export async function listenForPostgresCompletions(connectionString: string): Promise<() => Promise<void>> {
  const connection = new Client({ connectionString });
  await connection.connect();
  connection.on('notification', message => {
    if (message.channel === COMMAND_COMPLETION_CHANNEL && message.payload)
      notifyCommandCompletion(message.payload);
  });
  await connection.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
  return () => connection.end();
}
