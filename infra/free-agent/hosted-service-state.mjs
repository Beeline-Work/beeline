// Read-only state/sign-in probe inside a disposable hosted image. Never print
// Squire URLs, browser passwords or account metadata into the proof artifact.
import { readFileSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const env = { ...process.env, HOME: '/root', XDG_RUNTIME_DIR: '/run/user/0',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus', XDG_CONFIG_HOME: '/root/.config',
  TRUSTY_SQUIRE_PROFILE_DIR: '/root/.trusty-squire/chrome-profile', TRUSTY_SQUIRE_BROKER_SOCKET: '/root/.trusty-squire/broker.sock' };
const unit = (...args) => spawnSync('systemctl', ['--user', ...args], { env, encoding: 'utf8' }).stdout.trim();
const sockets = Object.fromEntries(['broker.sock', 'mcp.sock'].map(name => {
  try { return [name, statSync(`/root/.trusty-squire/${name}`).isSocket()]; }
  catch { return [name, false]; }
}));
const connect = await new Promise(resolve => {
  const child = spawn('node', ['/opt/beeline/squire/node_modules/@trusty-squire/mcp/dist/bin.js',
    'connect', '--json', '--target=codex', '--skip-browser'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '', last;
  const finish = (value) => { clearTimeout(timer); child.kill('SIGINT'); resolve(value); };
  const timer = setTimeout(() => finish(last ?? { timedOut: true }), 60_000);
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      let data; try { data = JSON.parse(line); } catch { continue; }
      if (!data.state) continue;
      last = { state: data.state, hasSignIn: !!data.sign_in_url, placement: data.browser_location?.kind };
      if (data.terminal || (data.state === 'needs-sign-in' && data.sign_in_url &&
          data.browser_location?.kind && !['none', 'unreachable'].includes(data.browser_location.kind))) finish(last);
    }
  });
  child.on('exit', code => { clearTimeout(timer); resolve(last ?? { exitCode: code }); });
  child.on('error', () => finish({ spawnFailed: true }));
});
console.log(JSON.stringify({ at: new Date().toISOString(), bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  manager: unit('is-system-running'), managerHome: unit('show-environment').split('\n').find(line => line.startsWith('HOME=')), broker: unit('is-active', 'trusty-squire-broker.service'),
  enabled: unit('is-enabled', 'trusty-squire-broker.service'), sockets, connect }));
