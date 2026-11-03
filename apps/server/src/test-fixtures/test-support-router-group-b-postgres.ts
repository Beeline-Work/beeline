import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate, PostgresDatabase } from '../database.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from '../command-completion.js';

/** Full production migrations in a disposable database, never the supplied DB.
 * P12 socket proofs need the actual triggers and services, not an SQL mock. */
export async function groupBPostgresDatabase(url: string, migrateSchema = true) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Group B proofs require isolated loopback PostgreSQL');
  const name = `router_group_b_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url); target.pathname = `/${name}`;
  const database = new PostgresDatabase(target.toString(), 3);
  const close = async () => {
    await database.close();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  };
  try {
    if (migrateSchema) await migrate(database);
    // Open physical pool connections before tests install synthetic clocks;
    // advancing a business clock must not expire an unstarted TCP handshake.
    const clients = await Promise.all([0, 1, 2].map(() => database.connectDedicated()));
    for (const client of clients) client.release();
  }
  catch (error) { await close(); throw error; }
  return { database, close, connectionString: target.toString(), listenToCompletions: async () => {
    const client = await database.connectDedicated();
    client.on('notification', message => {
      if (message.channel === COMMAND_COMPLETION_CHANNEL && message.payload)
        notifyCommandCompletion(message.payload);
    });
    await client.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
    return async () => { await client.query(`UNLISTEN ${COMMAND_COMPLETION_CHANNEL}`); client.release(); };
  } };
}
