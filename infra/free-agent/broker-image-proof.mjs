// Run only in a disposable hosted-services container, with this file mounted at
// /opt/beeline/broker-image-proof.mjs and a private writable cgroup namespace:
// docker run --rm --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
//   -v "$PWD/infra/free-agent/broker-image-proof.mjs:/opt/beeline/broker-image-proof.mjs:ro" \
//   --entrypoint node jellybean-hosted-marker:proof /opt/beeline/broker-image-proof.mjs
// Docker directory replacement stands in for Fly replacing image directory inodes.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (process.env.HOME !== '/root' || !process.env.XDG_RUNTIME_DIR)
  throw new Error('Use a disposable hosted-services container');
const dir = '/root/.trusty-squire';
const profile = `${dir}/chrome-profile`;
const markerPath = `${dir}/.trusty-squire-broker-unit.json`;
const socket = `${dir}/broker.sock`;
process.env.TRUSTY_SQUIRE_PROFILE_DIR = profile;
process.env.TRUSTY_SQUIRE_BROKER_SOCKET = socket;
const { connectBroker, brokerConnectionTarget } = await import('/opt/beeline/squire/node_modules/@trusty-squire/mcp/dist/bot/broker/discovery.js');
mkdirSync(profile, { recursive: true });
chmodSync(dir, 0o700);
const anchor = statSync(dir);
const binding = 'image-proof-existing-account';
writeFileSync(markerPath, JSON.stringify({ version: 1, socket,
  profile: { dev: anchor.dev, ino: anchor.ino, name: 'chrome-profile' }, accountBinding: binding }), { mode: 0o600 });
writeFileSync(`${profile}/persisted-session-fixture`, 'existing profile data');
mkdirSync('/root/.config/systemd/user/trusty-squire-broker.service.d', { recursive: true });
writeFileSync('/root/.config/systemd/user/trusty-squire-broker.service.d/proof.conf',
  '[Service]\nStandardOutput=append:/tmp/broker-proof.log\nStandardError=append:/tmp/broker-proof.log\n');
execFileSync('sh', ['/opt/beeline/hosted-services.sh']);
const unit = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'pipe' });
async function connected() {
  const client = await connectBroker(socket, { accountId: binding });
  assert.equal(client.isConnected(), true);
  await client.close();
}
try {
  unit('start', 'trusty-squire-broker.service');
  await connected();
  unit('stop', 'trusty-squire-broker.service');
  renameSync(dir, `${dir}-old`);
  cpSync(`${dir}-old`, dir, { recursive: true, filter: path => !path.endsWith('.sock') });
  assert.notEqual(statSync(dir).ino, anchor.ino);
  await assert.rejects(brokerConnectionTarget(profile, socket, { accountId: binding }), /Refusing to join/);
  // Only start the shipped unit: its ExecStartPre must repair the stale anchor.
  unit('start', 'trusty-squire-broker.service');
  await connected();
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  assert.equal(marker.profile.ino, statSync(dir).ino);
  assert.equal(marker.accountBinding, binding);
  assert.equal(readFileSync(`${profile}/persisted-session-fixture`, 'utf8'), 'existing profile data');
  console.log('PASS: real Squire broker connects after directory replacement; unit start repairs metadata and preserves binding/profile data.');
  console.log('Directory replacement and account fixture stand in for a Fly image move and previously signed-in account.');
} catch (error) {
  console.error(readFileSync('/tmp/broker-proof.log', 'utf8'));
  throw error;
} finally {
  unit('stop', 'trusty-squire-broker.service');
}
