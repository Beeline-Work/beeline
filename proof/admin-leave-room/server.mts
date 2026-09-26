import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { migrate } from '../../apps/server/src/database.js';
import { PgliteDatabase } from '../../apps/server/src/test-support.js';
import { PhoneService } from '../../apps/server/src/phone-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceId = randomUUID();
const ordinaryId = randomUUID();
const lastId = randomUUID();
const admin = createHash('sha256').update('proof:admin').digest('hex');
const otherAdmin = createHash('sha256').update('proof:other-admin').digest('hex');
const member = createHash('sha256').update('proof:member').digest('hex');
const database = new PgliteDatabase();
await migrate(database);
await database.query(
  `INSERT INTO identities(id,kind,name) VALUES($1,'human','Admin'),($2,'human','Other admin'),($3,'human','Member')`,
  [admin, otherAdmin, member],
);
await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Clover')`, [workspaceId]);
await database.query(
  `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
   ($1,NULL,$2,'admin'),($1,NULL,$3,'admin'),($1,NULL,$4,'member')`,
  [workspaceId, admin, otherAdmin, member],
);
await database.query(
  `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'CloverGTO'),($2,$3,'Final admin')`,
  [ordinaryId, lastId, workspaceId],
);
await database.query(
  `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
   ($1,$2,$4,'admin'),($1,$2,$5,'admin'),($1,$2,$6,'member'),
   ($1,$3,$4,'admin'),($1,$3,$6,'member')`,
  [workspaceId, ordinaryId, lastId, admin, otherAdmin, member],
);
const phone = new PhoneService(database, 'http://127.0.0.1');
const bundle = await build({
  entryPoints: [join(here, 'app.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  alias: { '@/modal': join(here, 'modal.ts') },
  define: { 'process.env.NODE_ENV': '"development"' },
});
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Room leave proof</title><style>
*{box-sizing:border-box}body{margin:0;background:#121b23;color:#f4eee3;font:16px system-ui,sans-serif}main{max-width:900px;margin:52px auto;padding:0 24px}h1{font-size:29px;font-weight:550}p{color:#b7c4ca}.deck{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:32px}.card{padding:24px;border:1px solid #52616b;border-radius:12px;background:#1b2831}.card h2{margin:0;font-size:21px}.card p{min-height:48px}button{border:1px solid #b58a52;border-radius:6px;background:#302820;color:#eec48f;padding:11px 16px;font:inherit;cursor:pointer}.result{margin-top:28px;padding:16px;background:#25333a;border-radius:8px;min-height:54px}#modal-root:empty{display:none}.shade{position:fixed;inset:0;background:#000a;display:grid;place-items:center;padding:16px}.dialog{width:min(440px,100%);padding:28px;background:#26343d;border:1px solid #9d855f;border-radius:14px;box-shadow:0 24px 70px #0008}.dialog h2{margin-top:0}.dialog p{line-height:1.5}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.actions button:last-child{background:#9a4839;color:white;border-color:#9a4839}@media(max-width:600px){main{margin:25px auto}.deck{grid-template-columns:1fr}}
</style></head><body><main><h1>Rooms · Clover</h1><p>Signed in as Workspace admin</p><div class="deck" id="deck"></div><div class="result" id="result">Choose a Room to leave.</div></main><div id="modal-root"></div><script src="/app.js"></script></body></html>`;

const server = createServer((request, response) => {
  void (async () => {
    if (request.url === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(bundle.outputFiles[0]!.text);
      return;
    }
    if (request.url === '/api/state') {
      const chats = await phone.readChats(workspaceId, admin);
      const rooms = await database.query<{ id: string }>(
        `SELECT id FROM rooms WHERE id IN ($1,$2)`,
        [ordinaryId, lastId],
      );
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          chats: chats?.chats ?? [],
          remainingIds: rooms.rows.map((row) => row.id),
          ordinaryId,
          lastId,
        }),
      );
      return;
    }
    if (request.url === '/api/leave' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as {
        roomId: string;
        confirmDelete?: boolean;
      };
      try {
        await phone.execute(
          'leaveRoom',
          {
            roomId: input.roomId,
            ...(input.confirmDelete ? { confirmDelete: true as const } : {}),
          },
          admin,
        );
        response.writeHead(204);
        response.end();
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  })().catch((error) => {
    response.writeHead(500);
    response.end(String(error));
  });
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string')
    console.log(`PROOF_URL=http://127.0.0.1:${address.port}`);
});
