import type { SqlDatabase } from './database.js';

/** Dependency-free Live fanout owner. Feature schema installers must not load
 * the listener's imports just to define their fixed-channel notification SQL.
 * Exact payload text and transaction boundaries remain owned by each writer;
 * postgres-live.ts validates and decodes the two channels independently. */
export const POSTGRES_LIVE_CHANNEL = 'beeline_live_v1';
export const COMMAND_COMPLETION_CHANNEL = 'beeline_command_completion';

export function committedCommandNotificationSchema(): string {
  return `CREATE OR REPLACE FUNCTION beeline_notify_committed_command(payload text) RETURNS void
    LANGUAGE sql AS $$ SELECT pg_notify('beeline_command_completion',payload) $$;`;
}
export function liveControlNotificationSchema(): string {
  return `CREATE OR REPLACE FUNCTION beeline_notify_live_control(payload text) RETURNS void
    LANGUAGE sql AS $$ SELECT pg_notify('beeline_live_v1',payload) $$;`;
}

/** A command's SQL transaction owns completion; local callbacks are only hints. */
export async function notifyCommittedCommand(database: Pick<SqlDatabase, 'query'>,
  key: { principal: string; operation: string; commandId: string }): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(key)]);
}

/** Registration/takeover evidence carries no user-state projection or command
 * authority. The existing listener decodes this named agent_connection hint. */
export async function notifyAgentConnection(database: Pick<SqlDatabase, 'query'>,
  agentId: string, epoch: number): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL,
    JSON.stringify({ table: 'agent_connection', operation: 'UPDATE', roomId: '', agentId, epoch })]);
}
