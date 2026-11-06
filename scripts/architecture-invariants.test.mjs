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

it('rejects a planted phone write backdoor, including inside the HTTP server owner file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phone-write-door-'));
  const rule = readInvariants(process.cwd()).rules.find(rule => rule.id === 'phone.write-door');
  const sources = {
    'apps/mobile/sources/sync/transport/live-connection.ts': "class LiveConnection { sendRequest() { return {t:'req'}; } }",
    'apps/server/src/phone-operations.ts': 'const execute = () => { phone.execute(); phone.markRead(); phone.markUnread(); options.voice.join(); options.voice.leave(); options.voice.idle(); options.voice.resume(); options.voice.profiles.save(); options.voice.profiles.preview(); }; const effect = () => phone.stopScheduledWorkCommand();',
    'apps/server/src/server.ts': 'const httpPhoneOperation = () => dispatchPhoneOperation(); async function route() { phone.uploadMedia(); return options.voice.nativeStop(); }',
    'apps/server/src/rooms-mcp.ts': 'class RoomsMcp { call() { this.phone.execute(); this.phone.execute(); } }',
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    assert.deepEqual(judgeTree(root, { rules: [rule] }), []);
    for (const backdoor of ['options.phone.execute(name,input,viewer)', 'dispatchPhoneOperation(name,input,viewer)', 'options.phone.markUnread(room,viewer)', 'options.voice.join(room,viewer)']) {
      writeFileSync(path.join(root, 'apps/server/src/server.ts'),
        sources['apps/server/src/server.ts'] + `\nasync function route() { return ${backdoor}; }`);
      assert.match(judgeTree(root, { rules: [rule] }).join('\n'), /phone\.write-door/);
    }
    writeFileSync(path.join(root, 'apps/server/src/server.ts'), sources['apps/server/src/server.ts']);
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
