import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink, cp, rename, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedNativeProof } from '../../apps/body/src/lifecycle-test-guard.ts';
import { requestMachine } from '../../apps/body/src/machine-control.ts';
import { helperServiceUnit } from '../../apps/body/src/native-helper.ts';

if (!isolatedNativeProof(process.env))
  throw new Error('native lifecycle proof refuses a shared manager or install');
const fixture = await import('./fixture.mjs');
const { origin, agents, database, auth, stateRoot } = fixture;
const exec = promisify(execFile);
const evidence = [];
const env = {
  ...process.env,
  BEELINE_UPDATE_MANIFEST_URL: `${origin}/dl/manifest.json`,
  BEELINE_MONOLITH_BASE_URL: origin,
};
const cli = '/home/proof/.local/bin/beeline';
const unit = '/home/proof/.config/systemd/user/beeline-helper.service';
const systemctl = async (...args) =>
  (await exec('systemctl', ['--user', ...args], { env, timeout: 120_000 })).stdout;
let lastObservation;
const observe = (accept = () => true, timeout = 90_000) =>
  requestMachine(
    stateRoot,
    { operation: 'status' },
    (status) => {
      const observed = JSON.stringify({
        generation: status.generation,
        pid: status.pid,
        processState: status.processState,
        loadedRelease: status.loadedRelease,
        desiredRelease: status.desiredRelease,
      });
      if (observed !== lastObservation) {
        lastObservation = observed;
        console.log(`[native-status] ${observed}`);
      }
      return accept(status);
    },
    timeout,
  );
const serving = (status) =>
  status.processState === 'serving' && agents.every((id) => status.agents[id]?.state === 'serving');
async function entry(command, args = [], options = {}) {
  const result = await exec(command, args, {
    env,
    timeout: 600_000,
    maxBuffer: 1_000_000,
    ...options,
  });
  return result.stdout + result.stderr;
}
async function phase(name, body) {
  if (process.env.BEELINE_PROOF_PHASES && !new RegExp(process.env.BEELINE_PROOF_PHASES).test(name))
    return;
  const began = Date.now();
  console.log(`[native-proof] ${name}`);
  await body();
  evidence.push({ name, passed: true, elapsedMs: Date.now() - began });
  console.log(`[native-proof] passed ${name}`);
}
async function publish(version, commit, fault = '') {
  await fixture.makeRelease(version, commit, fault);
  if (!fault)
    await fixture.releases.notifyReleaseDelivered({
      version,
      sha: commit,
      changelogUrl: `${origin}/changes`,
    });
}
let baseline;
try {
  await systemctl(
    'set-environment',
    ...Object.entries(env)
      .filter(([name]) => /^(?:HOME|XDG_|DBUS_|BEELINE_)/.test(name))
      .map(([name, value]) => `${name}=${value}`),
  );
  await phase(
    'real shell installer, native service, legacy signed identity migration',
    async () => {
      const prior = JSON.parse(
        await readFile(`${stateRoot}/beeline/agents/${agents[1]}/runtime.json`, 'utf8'),
      );
      fixture.loseLegacyExchangeReply();
      console.log(
        await entry('/bin/sh', ['/workspace/relay-stack/web/install.sh'], {
          env: { ...env, BEELINE_INSTALL_BASE_URL: origin },
        }),
      );
      baseline = await observe(serving);
      const migrated = JSON.parse(
        await readFile(`${stateRoot}/beeline/agents/${agents[1]}/runtime.json`, 'utf8'),
      );
      for (const key of ['agent', 'body', 'accessPolicy', 'pairedBy', 'supervisorRoot'])
        assert.deepEqual(migrated[key], prior[key]);
      assert.equal(migrated.transport.kind, 'monolith');
      assert.equal(
        (await database.query('SELECT count(*)::int AS count FROM legacy_daemon_migrations'))
          .rows[0].count,
        1,
      );
      assert.match(
        await systemctl(
          'show',
          '-p',
          'ActiveState',
          '-p',
          'UnitFileState',
          '-p',
          'MainPID',
          'beeline-helper.service',
        ),
        /ActiveState=active/,
      );
    },
  );
  await phase('npx current-release update repairs an exit-79 dead helper', async () => {
    await systemctl('stop', 'beeline-helper.service');
    await writeFile(
      unit,
      '[Unit]\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=/bin/sh -c "exit 79"\nRestart=always\nRestartPreventExitStatus=79\n[Install]\nWantedBy=default.target\n',
    );
    await systemctl('daemon-reload');
    await systemctl('start', 'beeline-helper.service');
    await delay(300);
    assert.match(
      await systemctl(
        'show',
        '-p',
        'ActiveState',
        '-p',
        'ExecMainStatus',
        'beeline-helper.service',
      ),
      /ExecMainStatus=79/,
    );
    console.log(
      await entry('npx', [
        '--offline',
        '--yes',
        '--package',
        '/workspace/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
        'usebeeline',
        'update',
      ]),
    );
    const repaired = await observe(serving);
    assert.notEqual(repaired.generation, baseline.generation);
    assert.equal(await readFile(unit, 'utf8'), helperServiceUnit());
    baseline = repaired;
    console.log(await entry(cli, ['update']));
    assert.equal((await observe(serving)).generation, repaired.generation);
    for (const [command, args] of [
      [cli, ['update']],
      [
        'npx',
        [
          '--offline',
          '--yes',
          '--package',
          '/workspace/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
          'usebeeline',
          'start',
        ],
      ],
      [cli, ['start']],
    ]) {
      const previous = (await observe(serving)).generation;
      await systemctl('disable', '--now', 'beeline-helper.service');
      console.log(await entry(command, args));
      baseline = await observe(serving);
      assert.notEqual(baseline.generation, previous);
      assert.match(await systemctl('is-enabled', 'beeline-helper.service'), /enabled/);
    }
  });
  await phase(
    'scoped stop acknowledgment, preserved stop, start, all-stopped live helper',
    async () => {
      console.log(await entry(cli, ['stop', '--agent', agents[0]]));
      let status = await observe((s) => s.agents[agents[0]]?.state === 'stopped');
      assert.equal(status.agents[agents[1]].state, 'serving');
      const generation = status.generation;
      console.log(await entry(cli, ['update']));
      assert.equal((await observe()).agents[agents[0]].state, 'stopped');
      console.log(await entry(cli, ['stop', '--agent', agents[1]]));
      status = await observe((s) => agents.every((id) => s.agents[id]?.state === 'stopped'));
      assert.equal(status.generation, generation);
      assert.equal(status.processState, 'serving');
      console.log(await entry(cli, ['start', '--all']));
      baseline = await observe(serving);
      assert.equal(baseline.generation, generation);
    },
  );
  await phase(
    'old per-agent units, pinned ExecStart, real anchor and broken forwarder converge forward',
    async () => {
      await systemctl('stop', 'beeline-helper.service');
      await writeFile(
        '/home/proof/.config/systemd/user/beeline-agent@.service',
        '[Service]\nType=simple\nExecStart=/bin/sleep infinity\nRestart=always\n[Install]\nWantedBy=default.target\n',
      );
      await writeFile(
        unit,
        helperServiceUnit().replace(
          'ExecStart=%h/.local/bin/beeline helper-bootstrap',
          `ExecStart=/usr/local/bin/node /home/proof/.local/lib/beeline-releases/${baseline.loadedRelease}/lib/beeline/beeline-cli.mjs daemon --machine`,
        ),
      );
      await systemctl('daemon-reload');
      for (const id of agents) await systemctl('enable', '--now', `beeline-agent@${id}.service`);
      const anchor = '/home/proof/.local/lib/beeline';
      await cp(anchor, `${anchor}.fixture-copy`, { recursive: true, dereference: true });
      await unlink(anchor);
      await rename(`${anchor}.fixture-copy`, anchor);
      await writeFile(cli, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      console.log(
        await entry('npx', [
          '--offline',
          '--yes',
          '--package',
          '/workspace/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
          'usebeeline',
          'update',
        ]),
      );
      baseline = await observe(serving);
      assert.match(await readlink(anchor), /^beeline-releases\//);
      assert.equal(await readFile(unit, 'utf8'), helperServiceUnit());
      for (const id of agents)
        assert.match(
          await systemctl(
            'show',
            '-p',
            'ActiveState',
            '-p',
            'MainPID',
            `beeline-agent@${id}.service`,
          ),
          /MainPID=0/,
        );
      await writeFile(cli, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      const generation = baseline.generation;
      console.log(
        await entry('npx', [
          '--offline',
          '--yes',
          '--package',
          '/workspace/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
          'usebeeline',
          'update',
        ]),
      );
      assert.equal((await observe(serving)).generation, generation);
      assert.match(await entry(cli, ['--version']), /v0.2.0/);
    },
  );
  await phase('a legacy per-agent entry hands its own native unit to the sole helper', async () => {
    await systemctl('stop', 'beeline-helper.service');
    await writeFile(
      '/home/proof/.config/systemd/user/beeline-agent@.service',
      '[Service]\nType=simple\nEnvironment=BEELINE_MANAGED_BY_SYSTEMD=1\nExecStart=%h/.local/bin/beeline daemon --agent %i\nRestart=always\n[Install]\nWantedBy=default.target\n',
    );
    await systemctl('daemon-reload');
    await systemctl('enable', '--now', `beeline-agent@${agents[0]}.service`);
    baseline = await observe(serving);
    assert.match(
      await systemctl(
        'show',
        '-p',
        'ActiveState',
        '-p',
        'MainPID',
        `beeline-agent@${agents[0]}.service`,
      ),
      /MainPID=0/,
    );
    console.log(await entry(cli, ['update']));
  });
  await phase('kernel process death and native watchdog restart the sole owner', async () => {
    let successor = observe((s) => serving(s) && s.generation !== baseline.generation);
    await systemctl('kill', '--signal=SIGKILL', '--kill-whom=main', 'beeline-helper.service');
    baseline = await successor;
    await mkdir(`${unit}.d`, { recursive: true });
    await writeFile(
      `${unit}.d/proof-watchdog.conf`,
      '[Service]\nWatchdogSec=3s\nWatchdogSignal=SIGKILL\n',
    );
    await systemctl('daemon-reload');
    successor = observe((s) => serving(s) && s.generation !== baseline.generation);
    await systemctl('restart', 'beeline-helper.service');
    baseline = await successor;
    await delay(4500);
    assert.equal((await observe(serving)).generation, baseline.generation);
    successor = observe((s) => serving(s) && s.generation !== baseline.generation);
    await systemctl('kill', '--signal=SIGSTOP', '--kill-whom=main', 'beeline-helper.service');
    baseline = await successor;
    await unlink(`${unit}.d/proof-watchdog.conf`);
    await systemctl('daemon-reload');
  });
  await phase(
    'real command intake and reply through the fixture HTTP/WebSocket server',
    async () => {
      await fixture.addRoom();
      const id = await fixture.message('native first message');
      assert.equal((await fixture.waitReply(id, 60_000)).length, 1);
    },
  );
  await phase('invalid release checksum, import, and engine fail without activation', async () => {
    const generation = (await observe(serving)).generation;
    for (const fault of ['checksum', 'import', 'engine']) {
      await fixture.makeRelease('v0.2.1', '2'.repeat(40), fault);
      await assert.rejects(entry(cli, ['update']), /checksum|import|engine|Node|failed/i);
      assert.equal((await observe(serving)).generation, generation);
    }
    await fixture.makeRelease('v0.2.0', '1'.repeat(40));
  });
  await phase(
    'publication failure recovers verified serving code and reports freshness uncertainty',
    async () => {
      const previous = baseline.generation;
      fixture.setPublicationAvailable(false);
      await systemctl('stop', 'beeline-helper.service');
      try {
        await assert.rejects(entry(cli, ['update']), /freshness unconfirmed/);
        baseline = await observe(serving);
        assert.notEqual(baseline.generation, previous);
        const status = JSON.parse(await entry(cli, ['update', '--status']));
        assert.equal(status.releaseSelection.lastCheckResult, 'unconfirmed');
      } finally {
        fixture.setPublicationAvailable(true);
      }
      console.log(await entry(cli, ['update']));
    },
  );
  await phase('killed preparation child releases its kernel-owned lock', async () => {
    await fixture.makeRelease('v0.2.1', '2'.repeat(40));
    fixture.holdDownload(true);
    const download = fixture.nextDownload();
    const child = spawn(cli, ['update'], { env, stdio: 'ignore' });
    const exit = new Promise((done) => child.once('exit', done));
    await download;
    child.kill('SIGKILL');
    await exit;
    fixture.holdDownload(false);
    console.log(await entry(cli, ['update']));
    baseline = await observe(serving);
    assert.equal(baseline.loadedIdentity.version, 'v0.2.1');
  });
  await phase('busy update keeps intake open and hands over when quiet', async () => {
    fixture.holdWork(true);
    const started = fixture.nextHarness();
    const heldId = await fixture.message('native-held quiet-gap');
    await started;
    await publish('v0.2.2', '3'.repeat(40));
    await observe((s) => s.desiredRelease && s.desiredRelease !== s.loadedRelease);
    const during = await fixture.message('native mid-drain sibling', 1);
    assert.equal((await fixture.waitReply(during, 60_000)).length, 1);
    const successor = observe((s) => serving(s) && s.generation !== baseline.generation, 120_000);
    fixture.holdWork(false);
    assert.equal((await fixture.waitReply(heldId, 60_000)).length, 1);
    baseline = await successor;
    assert.equal(baseline.loadedIdentity.version, 'v0.2.2');
  });
  await phase(
    'a real five-minute busy drain journals and replays once on the newest release',
    async () => {
      fixture.holdWork(true);
      const started = fixture.nextHarness();
      const heldId = await fixture.message('native-held deadline-gap');
      await started;
      await publish('v0.2.3', '4'.repeat(40));
      await observe((s) => s.desiredRelease && s.desiredRelease !== s.loadedRelease);
      const began = Date.now();
      const updates = entry(cli, ['update']);
      const during = await fixture.message('native deadline-drain sibling', 1);
      assert.equal((await fixture.waitReply(during, 60_000)).length, 1);
      await publish('v0.2.4', '5'.repeat(40));
      await observe((s) => s.desiredRelease?.startsWith('5'.repeat(40)));
      const stopped = await observe((s) => s.processState === 'stopping', 310_000);
      assert.equal(stopped.generation, baseline.generation);
      assert.ok(Date.now() - began <= 305_000, 'a newer release must not renew the drain deadline');
      const journal = JSON.parse(
        await readFile(
          `${stateRoot}/beeline/agents/${agents[0]}/force-update-interruptions.json`,
          'utf8',
        ),
      );
      assert.ok(
        JSON.stringify(journal).includes(heldId),
        'active command identity is durable before cancellation',
      );
      await systemctl('kill', '--signal=SIGKILL', '--kill-whom=main', 'beeline-helper.service');
      fixture.holdWork(false);
      baseline = await observe((s) => serving(s) && s.generation !== stopped.generation, 120_000);
      console.log(await updates);
      assert.equal(baseline.loadedIdentity.version, 'v0.2.4');
      assert.equal((await fixture.waitReply(heldId, 90_000)).length, 1);
      const count = (
        await database.query(
          "SELECT count(*)::int AS count FROM messages WHERE request_id=$1 AND author_id=$2 AND presentation='message'",
          [heldId, agents[0]],
        )
      ).rows[0].count;
      assert.equal(count, 1);
      assert.equal(
        (
          await database.query(
            'SELECT hiccup_attempts FROM agent_commands WHERE turn_request_id=$1 AND agent_id=$2',
            [heldId, agents[0]],
          )
        ).rows[0].hiccup_attempts,
        0,
      );
    },
  );
  await phase(
    'unrecognized identity and malformed configuration fail by name while siblings serve',
    async () => {
      const unknown = await fixture.addUnrecognizedAgent();
      await assert.rejects(entry(cli, ['update']), new RegExp(unknown));
      let status = await observe((s) => s.agents[unknown]?.state === 'needs-auth');
      assert.ok(serving(status));
      const path = `${stateRoot}/beeline/agents/${unknown}/runtime.json`;
      await writeFile(path, '{broken');
      status = await observe((s) => s.agents[unknown]?.state === 'needs-config');
      assert.ok(serving(status));
      await assert.rejects(entry(cli, ['update']), new RegExp(unknown));
      await unlink(path);
      console.log(await entry(cli, ['update']));
    },
  );
  await phase(
    'revoked sign-in remains visible, and a runtime revision recovers only that agent',
    async () => {
      const path = `${stateRoot}/beeline/agents/${agents[0]}/runtime.json`;
      const runtime = JSON.parse(await readFile(path, 'utf8'));
      await database.query('UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1', [
        agents[0],
      ]);
      await delay(10_100); // Let the real authentication cache expire once.
      const request = await fixture.message('native auth refusal');
      const refused = await observe((s) => s.agents[agents[0]]?.state === 'needs-auth', 30_000);
      assert.equal(refused.agents[agents[1]].state, 'serving');
      await assert.rejects(entry(cli, ['update']), new RegExp(agents[0]));
      const exchange = await auth.createDaemonExchange(agents[0]);
      const replacement = await auth.exchangeDaemonToken(exchange.exchangeToken);
      runtime.transport.daemonToken = replacement.daemonToken;
      delete runtime.transport.exchangeToken;
      await writeFile(path, JSON.stringify(runtime));
      baseline = await observe(serving);
      assert.equal(baseline.generation, refused.generation);
      assert.equal((await fixture.waitReply(request, 60_000)).length, 1);
      const sibling = await fixture.message('native sibling after auth refusal', 1);
      assert.equal((await fixture.waitReply(sibling, 60_000)).length, 1);
    },
  );
  await phase('independent npx recovery repairs a body that cannot import', async () => {
    await systemctl('stop', 'beeline-helper.service');
    await writeFile(
      `/home/proof/.local/lib/beeline-releases/${baseline.loadedRelease}/lib/beeline/beeline-cli.mjs`,
      "throw new Error('damaged installed body');\n",
    );
    console.log(
      await entry('npx', [
        '--offline',
        '--yes',
        '--package',
        '/workspace/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
        'usebeeline',
        'update',
        '--force',
      ]),
    );
    baseline = await observe(serving);
    assert.match(baseline.loadedRelease, /repair/);
    assert.equal(baseline.loadedIdentity.version, 'v0.2.4');
  });
  await phase(
    'a pushed server minimum interrupts through the same prepared handoff and replays without retry cost',
    async () => {
      fixture.holdWork(true);
      const started = fixture.nextHarness();
      const heldId = await fixture.message('native-held server-minimum');
      await started;
      await fixture.makeRelease('v0.2.5', '6'.repeat(40));
      const stopped = observe((s) => s.processState === 'stopping', 90_000);
      const prior = baseline.generation;
      const startup = observe(
        (s) => s.generation !== prior && s.processState === 'starting',
        120_000,
      );
      const began = Date.now();
      fixture.helperVersionGate.raise('v0.2.5');
      await stopped;
      assert.ok(Date.now() - began < 90_000);
      const journal = JSON.parse(
        await readFile(
          `${stateRoot}/beeline/agents/${agents[0]}/force-update-interruptions.json`,
          'utf8',
        ),
      );
      assert.ok(JSON.stringify(journal).includes(heldId));
      fixture.holdWork(false);
      const interruptedStartup = await startup;
      await systemctl('kill', '--signal=SIGKILL', '--kill-whom=main', 'beeline-helper.service');
      baseline = await observe(
        (s) => serving(s) && s.generation !== interruptedStartup.generation,
        120_000,
      );
      assert.equal(baseline.loadedIdentity.version, 'v0.2.5');
      assert.equal((await fixture.waitReply(heldId, 90_000)).length, 1);
      assert.equal(
        (
          await database.query(
            'SELECT hiccup_attempts FROM agent_commands WHERE turn_request_id=$1 AND agent_id=$2',
            [heldId, agents[0]],
          )
        ).rows[0].hiccup_attempts,
        0,
      );
    },
  );
  await phase(
    'actual idle machine has no release, discovery, command or status HTTP reads',
    async () => {
      await delay(1000);
      const before = fixture.evidence().calls;
      await delay(30_000);
      const after = fixture.evidence().calls;
      for (const path of new Set([...Object.keys(before), ...Object.keys(after)]))
        if (/manifest|Bootstrap|getAgentConfiguration|getAgentCommands|getRoomInbox/.test(path))
          assert.equal(after[path] || 0, before[path] || 0, path);
      assert.equal((await observe(serving)).generation, baseline.generation);
    },
  );
  await phase('explicit native stop stays off', async () => {
    await systemctl('stop', 'beeline-helper.service');
    await delay(6500);
    assert.match(
      await systemctl('show', '-p', 'ActiveState', '-p', 'MainPID', 'beeline-helper.service'),
      /MainPID=0/,
    );
  });
  console.log(
    JSON.stringify(
      {
        platform: 'Linux systemd user@1001 in disposable Docker PID namespace',
        evidence,
        fixture: fixture.evidence(),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  console.error(JSON.stringify(fixture.evidence()));
  console.error(
    (await exec('ps', ['-u', String(process.getuid()), '-o', 'pid,ppid,stat,args'], { env }))
      .stdout,
  );
  console.error(
    await systemctl('status', '--no-pager', 'beeline-helper.service').catch(
      (e) => e.stdout + e.stderr,
    ),
  );
  console.error(
    (
      await exec(
        'journalctl',
        ['--user', '-u', 'beeline-helper.service', '--no-pager', '-n', '100'],
        { env },
      ).catch((e) => e)
    ).stdout,
  );
  process.exitCode = 1;
} finally {
  await systemctl('stop', 'beeline-helper.service').catch(() => {});
  await fixture.closeFixture();
}
