import type { SqlDatabase } from './database.js';
import { bundledMcpLogo } from './rooms-mcp-logos.js';

/**
 * Apps whose connector form asks for a client id instead of registering
 * themselves. Each id is published on usebeeline.app/connect/; it grants
 * nothing without the person's own sign-in and Allow, and the redirect stays
 * an exact match. Keep an id once published: live connections use it.
 */
export const PREREGISTERED_MCP_CLIENTS = [
  {
    id: '6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o',
    name: 'Meta Muse',
    redirects: ['https://agent.meta.ai/api/hatch/oauth/callback'],
  },
] as const;

/** Idempotent; an existing row keeps its name, logo and secret. */
export async function seedPreregisteredMcpClients(db: SqlDatabase): Promise<number> {
  for (const client of PREREGISTERED_MCP_CLIENTS) {
    const logo = await bundledMcpLogo(client.name);
    await db.query(
      `INSERT INTO rooms_mcp_clients(id,name,redirects,logo,auth_method,preregistered)
       VALUES($1,$2,$3::jsonb,$4,'none',true)
       ON CONFLICT(id) DO UPDATE SET redirects=EXCLUDED.redirects,preregistered=true,
         logo=COALESCE(rooms_mcp_clients.logo,EXCLUDED.logo)`,
      [client.id, client.name, JSON.stringify(client.redirects), logo ?? null],
    );
  }
  return PREREGISTERED_MCP_CLIENTS.length;
}
