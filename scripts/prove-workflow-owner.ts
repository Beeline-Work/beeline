#!/usr/bin/env node
/** OWNER-1: real authenticated agent starts and a built workflow page reading
 * the same isolated server. Chrome runs in the parent while the HTTP service
 * stays responsive in a child. No production state or live agent is used. */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { createAgentCommand } from '../apps/server/src/agent-command.js';
import { runBrowserProof, webProofShims } from '../apps/mobile/sources/test/browserProof.js';

const ROOM = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const HUMAN = createHash('sha256').update('github:workflow-owner-proof').digest('hex');
const OWNER = 'b'.repeat(64),
  PEER = 'c'.repeat(64);
const contract = {
  version: 1,
  name: 'daily',
  description: 'Daily scan',
  roles: ['scanner'],
  start: 'scan',
  handoffs: {
    scan: { role: 'scanner', requires: [], on: { done: 'done' } },
    done: { kind: 'terminal', status: 'done' },
  },
};
type Ready = {
  origin: string;
  phoneToken: string;
  runId: string;
  rejected: { status: number; error: string };
};

async function serve() {
  const db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Admin','admin'),($2,'agent','Scanner','scanner'),($3,'agent','Peer','peer')`,
    [HUMAN, OWNER, PEER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    OWNER,
    PEER,
    HUMAN,
  ]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [WORKSPACE]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Ownership proof')`,
    [ROOM, WORKSPACE, HUMAN],
  );
  for (const identity of [HUMAN, OWNER, PEER])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4),($1,NULL,$3,$4)`,
      [WORKSPACE, ROOM, identity, identity === HUMAN ? 'owner' : 'member'],
    );
  const auth = new TokenAuth(db, async () => ({
    subject: 'workflow-owner-proof',
    login: 'admin',
    name: 'Admin',
  }));
  const live = new LiveHub();
  const daemon = new DaemonService(
    db,
    live,
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    { enabled: true, live: true },
  );
  const server = createBeelineServer({
    database: db,
    auth,
    phone: new PhoneService(db, 'http://proof'),
    daemon,
    live,
    mediaMaximumBytes: 1024,
    webAppOrigins: ['null'],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (operation: string, body: unknown, token: string) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as Record<string, unknown>;
    return { status: response.status, data };
  };
  const turn = async (agentId: string) => {
    const { exchangeToken } = await auth.createDaemonExchange(agentId);
    const token = (await auth.exchangeDaemonToken(exchangeToken))!.daemonToken;
    const source = createHash('sha256').update(`proof:${agentId}`).digest('hex');
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Start daily')`,
      [source, ROOM, HUMAN],
    );
    const command = (await createAgentCommand(db, {
      roomId: ROOM,
      agentId,
      sourceMessageId: source,
      reason: 'human_tag',
    }))!;
    const scope = {
      roomId: ROOM,
      agentId,
      requestId: command.turn_request_id,
      generationId: `proof-${agentId[0]}`,
    };
    for (const [op, input] of [
      ['claimAgentCommand', { ...scope, commandId: command.id }],
      ['postAgentTurnReceipt', { ...scope, status: 'working' }],
    ] as const) {
      const result = await call(op, input, token);
      if (result.status !== 200) throw new Error(`${op}: ${JSON.stringify(result)}`);
    }
    return { token, scope };
  };
  const owner = await turn(OWNER),
    peer = await turn(PEER);
  const saved = await call('saveWorkflow', { ...owner.scope, contract }, owner.token);
  if (saved.status !== 200) throw new Error(`save: ${JSON.stringify(saved)}`);
  const started = await call(
    'startWorkflow',
    { ...owner.scope, name: 'daily', roleBindings: { scanner: OWNER } },
    owner.token,
  );
  if (started.status !== 200) throw new Error(`owner start: ${JSON.stringify(started)}`);
  const rejected = await call(
    'startWorkflow',
    { ...peer.scope, name: 'daily', roleBindings: { scanner: PEER } },
    peer.token,
  );
  const phoneToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
  process.send!({
    origin,
    phoneToken,
    runId: started.data.runId,
    rejected: { status: rejected.status, error: rejected.data.error },
  });
  process.on('message', () => {
    server.close(() => {
      void db.close().then(() => process.exit());
    });
  });
}

async function prove() {
  const child = fork(path.resolve('scripts/prove-workflow-owner.ts'), ['--serve'], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stdout?.on('data', (data) => {
    diagnostics += String(data);
  });
  child.stderr?.on('data', (data) => {
    diagnostics += String(data);
  });
  try {
    const ready = await new Promise<Ready>((resolve, reject) => {
      child.once('message', (value) => resolve(value as Ready));
      child.once('exit', (code) =>
        reject(new Error(`Proof server exited ${code}: ${diagnostics}`)),
      );
      child.once('error', reject);
    });
    if (
      ready.rejected.status !== 403 ||
      !ready.rejected.error.includes('Only Scanner') ||
      !ready.rejected.error.includes(ready.runId)
    )
      throw new Error(`Non-owner start did not match OWNER-1: ${JSON.stringify(ready.rejected)}`);
    const mobile = path.resolve('apps/mobile');
    const browser: unknown[] = [];
    for (const width of [1280, 390]) {
      const page = await runBrowserProof({
        mobile,
        entry: path.join(mobile, 'scripts/workflow-owner-proof.tsx'),
        width,
        query: width === 390 ? '?transfer=1' : '',
        shims: {
          ...webProofShims(mobile),
          'expo-router': `import React from 'react'; export const useFocusEffect=effect=>React.useEffect(effect,[effect]); export const useLocalSearchParams=()=>({roomId:'${ROOM}',name:'daily'}); export const router={back:()=>{},push:()=>{}};`,
          '@/sync/transport/monolith-operation': `export const monolithPhoneOperation=async(name,input)=>{
          const response=await fetch('${ready.origin}/v1/phone/operations/'+name,{method:'POST',headers:{authorization:'Bearer ${ready.phoneToken}','content-type':'application/json'},body:JSON.stringify(input)});
          const data=await response.json(); if(!response.ok) throw new Error(data.error); return data; };`,
        },
      });
      if (page.status !== 0 || !page.result.startsWith('{'))
        throw new Error(`Browser failed: ${page.result} ${page.stderr}`);
      const result = JSON.parse(page.result);
      if (
        !result.initial.includes('Owner') ||
        !result.initial.includes('Scanner') ||
        !result.initial.includes(ready.runId) ||
        !result.changeOwner ||
        result.overflow
      )
        throw new Error(`Owner page missing required output: ${page.result}`);
      if (width === 390 && !result.text.includes('Peer'))
        throw new Error(`Human transfer was not shown: ${page.result}`);
      browser.push({ width, ...result });
    }
    const evidence = {
      reproduction: 'OWNER-1',
      nonOwnerStart: ready.rejected,
      existingRunId: ready.runId,
      browser,
    };
    console.log(JSON.stringify(evidence, null, 2));
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + '\n');
  } finally {
    child.send?.('stop');
    child.kill();
  }
}
(process.argv[2] === '--serve' ? serve() : prove()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
