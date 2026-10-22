/** Local service proof: real migrations, identity assignment, Workspace creation and Room reads.
 * Provider verification and Fly are stand-ins; no production services are called. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PgliteDatabase } from '../../../server/src/test-support.ts';
import { migrate } from '../../../server/src/database.ts';
import { TokenAuth } from '../../../server/src/auth.ts';
import { PhoneService } from '../../../server/src/phone-service.ts';
import { FreeAgentService } from '../../../server/src/free-agents.ts';
const db = new PgliteDatabase();
await migrate(db);
const auth = new TokenAuth(db, async () => ({ subject: randomUUID(), login: 'octocat', name: 'Octo Cat', issuer: 'proof', audience: 'proof' }), undefined,
  async () => ({ subject: randomUUID(), email: 'newperson@example.test', name: 'New Person', audience: 'proof' }));
const phone = new PhoneService(db, 'http://127.0.0.1:45921');
phone.setFreeAgents(new FreeAgentService(db, { model: 'proof', idleSeconds: 60, maxPerOwner: 3, dailyTokenCap: 1000000, lifetimeTokenCap: 3000000, sealSecret: 'isolated-proof-secret', publicOrigin: 'http://127.0.0.1:45921', image: 'proof', region: 'iad', cpus: 1, memoryMb: 1024, reapIdleMs: 300000, deleteAfterMs: 86400000 }, {} as any, async () => { throw new Error('No Machine boot in this proof'); }, () => undefined));
createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-proof-identity');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.end(); return; }
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    const viewer = String(req.headers['x-proof-identity'] ?? '');
    if (req.url === '/signin') {
      const tokens = input.provider === 'github' ? await auth.exchangeGitHubOidc('proof') : await auth.exchangeGoogleOidc('proof');
      res.end(JSON.stringify({ identityId: tokens.identityId })); return;
    }
    if (req.url === '/operation') {
      const result = await phone.execute(input.name, input.input, viewer);
      if (input.name === 'createWorkspace') {
        const again = await phone.execute('createWorkspace', input.input, viewer);
        if (JSON.stringify(result) !== JSON.stringify(again)) throw new Error('Workspace retry changed its result');
      }
      res.end(JSON.stringify(result)); return;
    }
    if (req.url?.startsWith('/room/')) {
      const view = await phone.readRoom(req.url.slice(6), viewer);
      const hello = view?.messages.filter(m => m.text?.includes("Hi, I'm Beebee"));
      const cards = view?.messages.filter(m => m.onboarding?.kind === 'repository');
      if (hello?.length !== 1 || cards?.length !== 1) throw new Error('Expected exactly one hello and repository card');
      res.end(JSON.stringify(view)); return;
    }
    res.statusCode = 404; res.end('{}');
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({error: String(error)})); }
}).listen(45921, '127.0.0.1', () => console.log('Isolated onboarding service ready on 45921'));
