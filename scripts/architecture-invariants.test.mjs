import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { judgeTree, readInvariants } from './architecture-invariants.mjs';

it('rejects extra connection surfaces, mounts and triggers, including inside owner files', () => {
  mkdirSync(path.join(process.cwd(), '.beeline-proof'), { recursive: true });
  const root = mkdtempSync(path.join(process.cwd(), '.beeline-proof', 'connection-banner-'));
  const rules = readInvariants(process.cwd()).rules.filter(rule => rule.id.startsWith('phone.connection-error-'));
  assert.equal(rules.length, 3);
  const network = 'apps/mobile/sources/sync/transport/live-connection.ts';
  const banner = 'apps/mobile/sources/components/buzz/ConnectionStatus.tsx';
  const layout = 'apps/mobile/sources/app/(app)/_layout.tsx';
  const sources = {
    [network]: 'let connectionFailed=false; function setConnectionFailure(failed) { connectionFailed=failed; } export function useConnectionFailure() {} class LiveConnection { request() { setConnectionFailure(true); } }',
    [banner]: 'function ConnectionStatus() { const failed=useConnectionFailure(); return <IndexRow title="Beeline isn’t connected" />; }',
    [layout]: 'function RootLayout() { return <ConnectionStatus />; }',
  };
  const write = (file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  try {
    for (const [file, source] of Object.entries(sources)) write(file, source);
    assert.deepEqual(judgeTree(root, { rules }), []);
    for (const [file, extra, rule] of [
      ['apps/mobile/sources/feature.tsx', 'const Extra=()=> <IndexRow title="Couldn’t reach Beeline" />;', 'surface'],
      ['apps/mobile/sources/feature.tsx', 'const failed=useConnectionFailure();', 'surface'],
      [network, 'function onclose() { setConnectionFailure(true); }', 'trigger'],
      [network, 'connectionFailed=true;', 'trigger'],
      [layout, 'function Extra() { return <ConnectionStatus />; }', 'mount'],
      [layout, 'function Extra() { return React.createElement(ConnectionStatus); }', 'mount'],
    ]) {
      write(file, (sources[file] ?? '') + extra);
      assert.match(judgeTree(root, { rules }).join('\n'), new RegExp(`phone\\.connection-error-${rule}`));
      write(file, sources[file] ?? '');
    }
    write(network, sources[network].replace('setConnectionFailure(true);', 'setConnectionFailure(true); setConnectionFailure(true);'));
    assert.match(judgeTree(root, { rules }).join('\n'), /phone\.connection-error-trigger.*expected exactly/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('rejects a planted phone write backdoor, including inside an HTTP write owner file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phone-write-door-'));
  const rule = readInvariants(process.cwd()).rules.find(rule => rule.id === 'phone.write-door');
  const sources = {
    'apps/mobile/sources/sync/transport/live-connection.ts': "class LiveConnection { sendRequest() { return {t:'req'}; } }",
    'apps/server/src/phone-operations.ts': 'const execute = () => { phone.execute(); phone.markRead(); phone.markUnread(); options.voice.join(); options.voice.leave(); options.voice.idle(); options.voice.resume(); options.voice.profiles.save(); options.voice.profiles.preview(); }; const effect = () => phone.stopScheduledWorkCommand();',
    'apps/server/src/server.ts': 'const httpPhoneOperation = () => dispatchPhoneOperation();',
    'apps/server/src/server-authenticated-routes.ts': 'async function routeAuthenticated() { phone.uploadMedia(); }',
    'apps/server/src/server-route.ts': 'async function route() { return options.voice.nativeStop(); }',
    'apps/server/src/rooms-mcp.ts': 'class RoomsMcp { call() { this.phone.execute(); this.phone.execute(); } }',
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    assert.deepEqual(judgeTree(root, { rules: [rule] }), []);
    for (const backdoor of ['options.phone.execute(name,input,viewer)', 'dispatchPhoneOperation(name,input,viewer)', 'options.phone.markUnread(room,viewer)', 'options.voice.join(room,viewer)']) {
      writeFileSync(path.join(root, 'apps/server/src/server-route.ts'),
        sources['apps/server/src/server-route.ts'] + `\nasync function route() { return ${backdoor}; }`);
      assert.match(judgeTree(root, { rules: [rule] }).join('\n'), /phone\.write-door/);
    }
    writeFileSync(path.join(root, 'apps/server/src/server-route.ts'), sources['apps/server/src/server-route.ts']);
    writeFileSync(path.join(root, 'apps/mobile/sources/feature.ts'), "socket.send(JSON.stringify({t:'req',op:'sendFromWallet',args:{}}))");
    assert.match(judgeTree(root, { rules: [rule] }).join('\n'), /phone\.write-door/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A planted second process lifecycle caller must fail the same CI guard as production.
it('helper agent processes have one start/stop owner', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'beeline-process-boundary-'));
  try {
    const invariants = readInvariants(path.resolve('.'));
    const rule = invariants.rules.find(rule => rule.id === 'helper.agent-process');
    assert.ok(rule);
    mkdirSync(path.join(root, 'apps/body/src'), { recursive: true });
    const probe = path.join(root, 'apps/body/src/planted.ts');
    for (const source of [
      'client.startProcess();', 'client.stopProcess();',
      'const start = client.startProcess;', 'client["stopProcess"]();',
      'const { startProcess } = client; startProcess();',
      'Reflect.get(client, "stopProcess")();',
    ]) {
      writeFileSync(probe, source);
      const errors = judgeTree(root, { rules: [{ ...rule, ownerSites: undefined }] });
      assert.ok(errors.some(error => error.includes('helper.agent-process')), source);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('rejects every planted terminal writer, even another writer inside the owner file', () => {
  mkdirSync(path.join(process.cwd(), '.beeline-proof'), { recursive: true });
  const root = mkdtempSync(path.join(process.cwd(), '.beeline-proof', 'turn-owner-'));
  const rules = readInvariants(process.cwd()).rules.filter(rule =>
    ['work.command-terminal', 'work.turn-terminal', 'work.terminal-turn-insert', 'work.terminal-command-insert'].includes(rule.id));
  assert.equal(rules.length, 4);
  const owner = 'apps/server/src/agent-turn-end.ts';
  const source = "export const AGENT_TURN_END_SCHEMA = `UPDATE agent_commands SET state=outcome WHERE id=$1; UPDATE agent_turns SET status=outcome WHERE request_id=$1;`; function create() { return `INSERT INTO agent_commands(id,action,state) VALUES($1,'input','pending')`; }";
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  try {
    write(owner, source);
    assert.deepEqual(judgeTree(root, { rules }), []);
    for (const sql of [
      "INSERT INTO agent_commands SELECT * FROM terminal_commands",
      "INSERT INTO agent_turns VALUES($1,$2,$3,'failed')",
      "INSERT INTO agent_commands DEFAULT VALUES",
      "INSERT INTO agent_commands(id,state) VALUES($1,'complete')",
      "INSERT INTO agent_commands(id,state) VALUES($1,'pending') ON CONFLICT(id) DO UPDATE SET state='complete'",
      "INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'working') ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status='failed'",
      "INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'working'),($4,$5,$6,'complete')",
      "INSERT INTO agent_turns(room_id,request_id,agent_id,status) SELECT $1,$2,$3,'working' UNION ALL SELECT $4,$5,$6,'failed'",
      "UPDATE agent_commands SET state='complete' WHERE id=$1",
      "UPDATE agent_commands command SET completed_at=now(),state=$2 WHERE id=$1",
      'UPDATE "agent_commands" AS command SET "state"=$2 WHERE id=$1',
      "UPDATE agent_turns SET status='failed' WHERE request_id=$1",
      'UPDATE agent_turns SET status=EXCLUDED.status WHERE request_id=$1',
      "INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'complete')",
      'INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,$4)',
      'INSERT INTO agent_turns(status,room_id,request_id,agent_id) VALUES($1,$2,$3,$4)',
      `INSERT INTO "agent_turns"("status",room_id,request_id,agent_id) VALUES('failed',$1,$2,$3)`,
      "INSERT INTO agent_turns(room_id,request_id,agent_id,status) SELECT room_id,request_id,agent_id,'cancelled' FROM turns",
    ]) {
      write('apps/server/src/backdoor.ts', `function bypass() { return \`${sql}\`; }`);
      assert.match(judgeTree(root, { rules }).join('\n'), /work\.(?:command-terminal|turn-terminal|terminal-turn-insert|terminal-command-insert)/, sql);
      write('apps/server/src/backdoor.ts', '');
      write(owner, source + `\nfunction bypass() { return \`${sql}\`; }`);
      assert.notDeepEqual(judgeTree(root, { rules }), [], sql);
      write(owner, source);
    }
    write('apps/server/src/start.ts', "const start=`INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'working')`; const release=`UPDATE agent_commands SET state='pending',generation_id=NULL WHERE id=$1`;");
    assert.deepEqual(judgeTree(root, { rules }), []);
    write(owner, source.replace('UPDATE agent_turns SET status=outcome WHERE request_id=$1;', ''));
    assert.match(judgeTree(root, { rules }).join('\n'), /expected exactly 1 owned sink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('allows removing an owner and its sink without allowing new terminal owners', async () => {
  const { strictRelaxations } = await import('./architecture-invariants.mjs');
  const before = { id:'owner',strict:true,total:0,owners:['owner.ts'],ownerFunctions:{'owner.ts':['claim','renew']},ownerSites:2 };
  const tightened = {...before,ownerFunctions:{'owner.ts':['claim']},ownerSites:1};
  assert.deepEqual(strictRelaxations('',{rules:[before]},{rules:[tightened]}),[]);
  assert.notDeepEqual(strictRelaxations('',{rules:[tightened]},{rules:[before]}),[]);
});



it('rejects a tracked 1001-line file through the architecture check', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(path.join(tmpdir(), 'architecture-file-lines-'));
  const rule = readInvariants(process.cwd()).rules.find(rule => rule.id === 'code.file-lines');
  const file = 'apps/server/src/planted.ts';
  const write = (name, source) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), source);
  };
  const check = () => spawnSync(process.execPath, [fileURLToPath(new URL('./check-architecture.mjs', import.meta.url)), '--root', root], { encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q', root]);
    write('architecture/invariants.json', JSON.stringify({ rules: [rule] }));
    write('architecture/machine-connection-sinks.json', '{}');
    write(file, '// planted\n'.repeat(1001));
    execFileSync('git', ['add', '.'], { cwd: root });
    let result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /planted\.ts: 1001 lines exceeds 1000/);
    write(file, '// planted\n'.repeat(1000));
    assert.equal(check().status, 0);
    // Exact generated exclusions do not exempt neighboring source files.
    write(rule.generated[0], '// generated\n'.repeat(1001));
    execFileSync('git', ['add', '.'], { cwd: root });
    assert.equal(check().status, 0);
    write(file, '// planted\n'.repeat(1000) + '// last line without newline');
    assert.match(check().stderr, /1001 lines exceeds 1000/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});



it('permits identical sink moves while rejecting changed statements and empty new owners', async () => {
  const { execFileSync } = await import('node:child_process');
  const { strictRelaxations } = await import('./architecture-invariants.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'architecture-owner-move-'));
  const oldFile = 'apps/server/src/old.ts', newFile = 'apps/server/src/moved.ts';
  const write = (file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  const was = { id: 'sink', strict: true, pattern: 'database\\.query\\s*\\(', scope: ['apps/server/src'],
    owners: [oldFile], ownerFunctions: { [oldFile]: ['effect'] }, ownerSites: 1, total: 0 };
  const next = { ...was, owners: [newFile], ownerFunctions: { [newFile]: ['movedEffect'] } };
  const check = rule => strictRelaxations(root, { rules: [was] }, { rules: [rule] }, 'HEAD');
  try {
    execFileSync('git', ['init', '-q', root]);
    write(oldFile, 'function effect(database) { return database.query("original"); }');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    write(newFile, 'export function movedEffect(database) { return database.query("original"); }');
    assert.deepEqual(check(next), []);
    write(newFile, 'export function movedEffect(database) { return database.query("changed"); }');
    assert.match(check(next).join('\n'), /owners changed/);
    write(newFile, 'export function movedEffect(database) { database.query("original"); return database.query("original"); }');
    assert.match(check(next).join('\n'), /owners changed/);
    write(newFile, 'export function movedEffect(database) { return database.query("original"); }');
    const empty = 'apps/server/src/empty.ts';
    write(empty, 'export const empty = true;');
    assert.match(check({ ...next, owners: [newFile, empty] }).join('\n'), /owners changed/);
    assert.match(check({ ...next, pattern: 'query' }).join('\n'), /pattern changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('permits relocating unchanged strict functions, never altered bodies or a second owner', async () => {
  const { strictRelaxations } = await import('./architecture-invariants.mjs');
  const root = mkdtempSync(path.join(process.cwd(), '.beeline-proof', 'owner-relocation-'));
  const source = 'export async function original(db) { await db.query(`UPDATE rooms SET archived_at=now()`); }';
  const before = { id:'archive',strict:true,total:0,owners:['old.ts'],ownerFunctions:{'old.ts':['original']},ownerSites:1 };
  const after = {...before,owners:['new.ts'],ownerFunctions:{'new.ts':['moved']}};
  const check = rule => strictRelaxations(root,{rules:[before]},{rules:[rule]},() => source);
  try {
    writeFileSync(path.join(root,'new.ts'), source.replace('original','moved'));
    assert.deepEqual(check(after),[]);
    assert.notDeepEqual(check({...after,owners:['old.ts','new.ts']}),[]);
    assert.notDeepEqual(check({...after,ownerSites:2}),[]);
    writeFileSync(path.join(root,'new.ts'), source.replace('original','moved').replace('now()','NULL'));
    assert.notDeepEqual(check(after),[]);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
