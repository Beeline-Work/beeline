// Sandbox tests for scripts/deploy-relay-host.sh's production-stack rollout
// stage. There was no pre-existing harness for this script; these use
// node:test with stubbed `docker`/`sudo` binaries and a local HTTP server for
// the public-verification round-trips, so the full script runs end-to-end
// without touching the real host, real containers, or the real sudoers rules.
//
// The stubs PIN the exact privileged invocation shapes — if the script drifts
// from the fixed-argument sudoers rules documented in its header, these tests
// fail.
//
//   node --test scripts/deploy-relay-host.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'deploy-relay-host.sh');
const TRACKED_COMPOSE = path.join(REPO, 'relay-stack', 'prod', 'compose.yml');
const TRACKED_NGINX = path.join(REPO, 'relay-stack', 'prod', 'nginx.conf');

// The live host files as they were before this change (hand-maintained,
// untracked): the tracked copies must converge them to the materializer
// shape. We only need a marker difference, but using the REAL pre-change
// content keeps the first-rollout scenario honest.
const PRE_CHANGE_COMPOSE = fs
  .readFileSync(TRACKED_COMPOSE, 'utf8')
  .replace(/^  materializer:$/m, '  push-gateway:')
  .replace('beeline-materializer:production', 'beeline-push-gateway:production')
  .replace(/# nginx resolves proxy_pass upstreams[\s\S]*?condition: service_healthy\n/, '');
const PRE_CHANGE_NGINX = fs
  .readFileSync(TRACKED_NGINX, 'utf8')
  .replace('http://materializer:8788/', 'http://push-host:8788/');

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-deploy-test.'));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeFakeBin(binDir, stateDir) {
  // Written with __STATE__/__BIN__ tokens (no shell-escaping games): what
  // lands in the stub files must be plain bash.
  const docker = String.raw`#!/usr/bin/env bash
STATE=__STATE__
log() { echo "docker $*" >> "$STATE/docker.log"; }
cmd="$1"; shift
case "$cmd" in
  build)
    ;;
  image)
    echo "sha256:fakeauthimage0000000000000000000000000000000000000000000000000000"
    ;;
  ps)
    all=0
    [ "$1" = "-aq" ] && all=1
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--filter" ] && echo "$a" | grep -q "service=materializer" && [ -f "$STATE/materializer-running" ]; then
        echo "gwcontainerid"
      fi
      if [ "$prev" = "--filter" ] && echo "$a" | grep -q "service=push-gateway" && [ -f "$STATE/push-gateway-running" ]; then
        echo "legacygwcontainerid"
      fi
      if [ "$prev" = "--filter" ] && echo "$a" | grep -q "service=auth" && [ -f "$STATE/auth-running" ]; then
        echo "authcontainerid"
      fi
      if [ "$prev" = "--filter" ] && echo "$a" | grep -q "service=relay$"; then
        echo "relaycontainerid"
      fi
      if [ "$prev" = "--filter" ] && echo "$a" | grep -q "service=relay-front"; then
        echo "frontcontainerid"
      fi
      prev="$a"
    done
    ;;
  inspect)
    last=""
    for last in "$@"; do :; done
    case "$last" in
      frontcontainerid) echo "running" ;;
      authcontainerid|gwcontainerid|legacygwcontainerid|relaycontainerid) echo "healthy" ;;
      *) echo "missing fixture container" >&2; exit 1 ;;
    esac
    ;;
  network)
    ;;
  run)
    ;;
  kill)
    log "kill $*"
    ;;
  stop)
    log "stop $*"
    for cid in "$@"; do
      case "$cid" in
        legacygwcontainerid)
          [ -f "$STATE/sticky-push-gateway" ] || rm -f "$STATE/push-gateway-running"
          ;;
        gwcontainerid)
          rm -f "$STATE/materializer-running"
          ;;
        *) echo "unknown container: $cid" >&2; exit 1 ;;
      esac
    done
    ;;
  compose)
    log "compose $*"
    # Emulate compose resolving env_file entries from the -f file AS THE
    # INVOKING USER (the real failure mode of run 32615214417): any listed
    # path the caller cannot read must fail validation.
    case "$*" in
      *config*)
        f=""; prev=""
        for a in "$@"; do
          [ "$prev" = "-f" ] && f="$a"
          prev="$a"
        done
        if [ -n "$f" ]; then
          unread=$(awk '
            /^[[:space:]]*env_file:/ { inlist=1; next }
            inlist && /^[[:space:]]*-[[:space:]]/ {
              line=$0; sub(/^[[:space:]]*-[[:space:]]*/, "", line); print line; next
            }
            { inlist=0 }
          ' "$f" | while IFS= read -r ef; do
            case "$ef" in
              /*) p="$ef" ;;
              *) p="$(dirname "$f")/$ef" ;;
            esac
            [ -r "$p" ] || echo "$p"
          done)
          if [ -n "$unread" ]; then
            echo "open $unread: permission denied" >&2
            exit 1
          fi
        fi
        ;;
    esac
    # Only a FULL-stack up can be made to fail; the pre-existing auth-only
    # recreation always succeeds.
    case "$*" in
      *"up -d --no-deps auth") ;;
      *"up -d"*)
        if [ -f "$STATE/push-gateway-running" ] || [ -f "$STATE/materializer-running" ]; then
          echo "tail owner overlap" >&2
          exit 1
        fi
        if [ -f "$STATE/fail-compose-up" ]; then
          echo "simulated compose up failure" >&2
          exit 1
        fi
        touch "$STATE/materializer-running" "$STATE/auth-running"
        ;;
    esac
    ;;
  *)
    echo "unexpected docker subcommand: $cmd $*" >&2
    exit 64
    ;;
esac
`;
  const sudo = String.raw`#!/usr/bin/env bash
STATE=__STATE__
echo "sudo $*" >> "$STATE/sudo.log"
[ "$1" = "-n" ] && shift
if [ "$1" = "-u" ]; then
  [ "$2" = "lunchbox" ] || { echo "sudoers REFUSAL (user)" >&2; exit 1; }
  shift 2
fi
case "$1" in
  /usr/bin/install)
    shift
    if [ "$2" != "lunchbox" ] || [ "$4" != "lunchbox" ] || [ "$6" != "644" ]; then
      echo "sudoers REFUSAL (install shape)" >&2; exit 1
    fi
    src="$7"; dst="$8"
    case "$dst" in
      */compose.yml|*/relay-front/nginx.conf) ;;
      *) echo "sudoers REFUSAL (install dest)" >&2; exit 1 ;;
    esac
    cp "$src" "$dst"
    ;;
  /usr/bin/docker)
    shift
    if [ "$1" != "compose" ] || [ "$2" != "-p" ] || [ "$3" != "buzz-router-prod" ]; then
      echo "sudoers REFUSAL (compose project)" >&2; exit 1
    fi
    shift 3
    rest=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --env-file|-f) shift 2 ;;
        *) rest="$rest $1"; shift ;;
      esac
    done
    case "$rest" in
      " up -d --remove-orphans") exec __BIN__/docker compose -p buzz-router-prod up -d --remove-orphans ;;
      *) echo "sudoers REFUSAL (compose args):$rest" >&2; exit 1 ;;
    esac
    ;;
  /usr/bin/env)
    shift
    [ "$1" = "XDG_RUNTIME_DIR=/run/user/1000" ] || { echo "sudoers REFUSAL (runtime dir)" >&2; exit 1; }
    shift
    [ "$1" = "/usr/bin/systemctl" ] && [ "$2" = "--user" ] || { echo "sudoers REFUSAL (systemctl)" >&2; exit 1; }
    [ -f "$STATE/events-service-present" ] || { echo "sudoers REFUSAL (events unit is absent)" >&2; exit 1; }
    action="$3"
    [ "$4" = "beeline-events.service" ] || [ "$5" = "beeline-events.service" ] || { echo "sudoers REFUSAL (events unit)" >&2; exit 1; }
    case "$action" in
      is-active)
        if [ -f "$STATE/events-running" ]; then echo active; else echo inactive; exit 3; fi
        ;;
      is-enabled)
        if [ -f "$STATE/events-running" ]; then echo enabled; else echo disabled; exit 1; fi
        ;;
      disable)
        [ "$4" = "--now" ] || { echo "sudoers REFUSAL (disable args)" >&2; exit 1; }
        rm -f "$STATE/events-running"
        ;;
      *) echo "sudoers REFUSAL (systemctl action)" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "sudoers REFUSAL (command)" >&2; exit 1
    ;;
esac
`;
  const systemctl = String.raw`#!/usr/bin/env bash
STATE=__STATE__
[ "$1" = "--user" ] && shift
[ "$1" = "list-unit-files" ] || { echo "unexpected systemctl invocation: $*" >&2; exit 64; }
[ -f "$STATE/events-service-present" ] && echo "beeline-events.service enabled"
`;
  write(
    path.join(binDir, 'docker'),
    docker.replaceAll('__STATE__', stateDir).replaceAll('__BIN__', binDir),
  );
  write(
    path.join(binDir, 'sudo'),
    sudo.replaceAll('__STATE__', stateDir).replaceAll('__BIN__', binDir),
  );
  write(path.join(binDir, 'systemctl'), systemctl.replaceAll('__STATE__', stateDir));
  write(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'docker'), 0o755);
  fs.chmodSync(path.join(binDir, 'sudo'), 0o755);
  fs.chmodSync(path.join(binDir, 'systemctl'), 0o755);
  fs.chmodSync(path.join(binDir, 'sleep'), 0o755);
}

async function withPublicServer(fn, opts = {}) {
  const server = http.createServer((req, res) => {
    const serve = (file) => {
      try {
        res.end(fs.readFileSync(file));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    };
    if (req.url === '/install' && opts.failPublic) res.end('stale install\n');
    else if (req.url === '/install') serve(path.join(REPO, 'relay-stack/web/install.sh'));
    else if (req.url === '/dl/manifest.json')
      serve(path.join(REPO, 'relay-stack/web/dl/manifest.json'));
    else if (req.url?.startsWith('/dl/') && req.url.endsWith('.sha256'))
      serve(path.join(REPO, 'relay-stack/web/dl', req.url.slice(4)));
    else if (req.url?.startsWith('/dl/'))
      serve(path.join(REPO, 'relay-stack/web/dl', req.url.slice(4)));
    else if (req.url?.startsWith('/.well-known/')) {
      res.statusCode = 200;
      res.end('{}');
    } else if (req.url === '/auth/capabilities') {
      res.statusCode = 200;
      res.end('{}');
    } else if (req.url === '/push/health') {
      res.statusCode = 200;
      res.end('ok');
    } else if (req.url === '/workspaces') {
      res.statusCode = 401;
      res.end('{"error":"valid_identity_authorization_required"}');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`, () => server.close());
  } finally {
    server.close();
  }
}

function runDeploy(opts) {
  const tmp = mkdtemp();
  const proj = path.join(tmp, 'prod');
  const binDir = path.join(tmp, 'bin');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(binDir);
  fs.mkdirSync(stateDir);

  // Live host shape before the deploy: pre-change config + a token webroot.
  write(path.join(proj, 'compose.yml'), opts.liveCompose ?? PRE_CHANGE_COMPOSE);
  write(path.join(proj, 'relay-front/nginx.conf'), opts.liveNginx ?? PRE_CHANGE_NGINX);
  write(path.join(proj, 'relay-front/web/index.html'), 'old web tree\n');
  write(
    path.join(proj, '.env'),
    'POSTGRES_PASSWORD=real-secret\nREDIS_PASSWORD=real\nBUZZ_S3_ACCESS_KEY=k\nBUZZ_S3_SECRET_KEY=s\n',
  );
  if (opts.eventsServicePresent !== false) {
    write(path.join(stateDir, 'events-service-present'), '1');
    if (opts.eventsRunning !== false) write(path.join(stateDir, 'events-running'), '1');
  }
  if (opts.existingMaterializer) write(path.join(stateDir, 'materializer-running'), '1');
  else write(path.join(stateDir, 'push-gateway-running'), '1');
  if (opts.stickyPushGateway) write(path.join(stateDir, 'sticky-push-gateway'), '1');
  if (opts.failComposeUp) write(path.join(stateDir, 'fail-compose-up'), '1');
  const stackStageDir = path.join(tmp, 'stage');

  makeFakeBin(binDir, stateDir);

  let publicBase = '';
  return withPublicServer(async (base, closeServer) => {
    publicBase = base;
    // Async spawn, NOT execFileSync: the public-verification round-trips hit
    // an HTTP server hosted in THIS process, so the event loop must keep
    // running while the deploy script waits on curl.
    const result = await new Promise((resolve) => {
      const child = spawn('bash', process.env.DEBUG_DEPLOY_TEST ? ['-x', SCRIPT] : [SCRIPT], {
        cwd: REPO,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: tmp,
          BEELINE_PROD_DIR: proj,
          BEELINE_PUBLIC_BASE: base,
          BEELINE_STACK_STAGE_DIR: stackStageDir,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
    });
    closeServer();
    if (process.env.DEBUG_DEPLOY_TEST) {
      fs.writeFileSync(
        '/tmp/deploy-test-debug.log',
        `STATUS ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\n`,
      );
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      proj,
      tmp,
      stateDir,
      readLive: (rel) => fs.readFileSync(path.join(proj, rel), 'utf8'),
      sudoLog: () =>
        fs.existsSync(path.join(stateDir, 'sudo.log'))
          ? fs.readFileSync(path.join(stateDir, 'sudo.log'), 'utf8')
          : '',
      dockerLog: () =>
        fs.existsSync(path.join(stateDir, 'docker.log'))
          ? fs.readFileSync(path.join(stateDir, 'docker.log'), 'utf8')
          : '',
      eventsRunning: () => fs.existsSync(path.join(stateDir, 'events-running')),
      materializerRunning: () => fs.existsSync(path.join(stateDir, 'materializer-running')),
    };
  }, opts);
}

test('first rollout installs both config files, runs one full reconcile through the existing sudo rule, and waits for health', async () => {
  const r = await runDeploy({});
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.equal(r.readLive('compose.yml'), fs.readFileSync(TRACKED_COMPOSE, 'utf8'));
  assert.equal(r.readLive('relay-front/nginx.conf'), fs.readFileSync(TRACKED_NGINX, 'utf8'));

  // Exactly one FULL-stack up through sudo. Auth is part of this reconcile,
  // never raced by a preceding auth-only container replacement.
  const ups = r
    .dockerLog()
    .split('\n')
    .filter((l) => l.includes('compose ') && l.includes('up -d') && !l.includes('--no-deps auth'));
  assert.equal(ups.length, 1, r.dockerLog());
  assert.ok(ups[0].includes('-p buzz-router-prod'));
  assert.ok(ups[0].endsWith('up -d --remove-orphans'));
  const dockerOperations = r.dockerLog().trim().split('\n');
  const legacyStop = dockerOperations.findIndex(
    (line) => line === 'docker stop legacygwcontainerid',
  );
  const materializerStart = dockerOperations.findIndex((line) => line.includes('up -d'));
  assert.notEqual(legacyStop, -1, r.dockerLog());
  assert.ok(legacyStop < materializerStart, r.dockerLog());
  assert.equal(
    r
      .sudoLog()
      .split('\n')
      .filter((l) => l.includes('--no-deps auth')).length,
    0,
  );
  assert.ok(r.stdout.includes('production stack health verified'));
  assert.ok(r.sudoLog().includes('disable --now beeline-events.service'), r.sudoLog());
  assert.equal(r.eventsRunning(), false, 'standalone events unit must stay retired after success');

  // nginx HUP reload happened exactly once.
  assert.equal(
    r
      .dockerLog()
      .split('\n')
      .filter((l) => l.includes('kill -s HUP')).length,
    1,
  );
});

test('an absent standalone events unit skips retirement and continues deployment', async () => {
  const r = await runDeploy({ eventsServicePresent: false });
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.ok(r.stdout.includes('already absent'), r.stdout);
  assert.equal(r.sudoLog().includes('beeline-events.service'), false, r.sudoLog());
  assert.equal(r.materializerRunning(), true);
});

function composeConfig(relative, overrides = {}) {
  const composeFile = path.join(REPO, relative);
  const env = {
    ...process.env,
    POSTGRES_PASSWORD: 'compose-test',
    POSTGRES_USER: 'buzz',
    POSTGRES_DB: 'buzz',
    REDIS_PASSWORD: 'compose-test',
    BUZZ_S3_ACCESS_KEY: 'compose-test',
    BUZZ_S3_SECRET_KEY: 'compose-test',
  };
  delete env.BEELINE_RUNTIME_STATE_DIR;
  Object.assign(env, overrides);
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--project-directory',
      path.dirname(composeFile),
      '-f',
      composeFile,
      'config',
      '--format',
      'json',
      '--no-env-resolution',
    ],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('tracked stacks expose one materializer service instead of separate tail processes', () => {
  for (const relative of ['relay-stack/compose.yml', 'relay-stack/prod/compose.yml']) {
    const services = Object.keys(composeConfig(relative).services);
    assert.equal(services.filter((service) => service === 'materializer').length, 1, relative);
    assert.equal(services.includes('push-gateway'), false, relative);
    assert.equal(services.includes('events'), false, relative);
    assert.equal(services.includes('snapshot-materializer'), false, relative);
  }
});

test('materializer preserves persisted absolute runtime roots inside the container', () => {
  for (const relative of ['relay-stack/compose.yml', 'relay-stack/prod/compose.yml']) {
    for (const runtimeRoot of ['/home/lunchbox/.local/state', '/srv/beeline-runtime']) {
      const overrides =
        runtimeRoot === '/home/lunchbox/.local/state'
          ? {}
          : { BEELINE_RUNTIME_STATE_DIR: runtimeRoot };
      const materializer = composeConfig(relative, overrides).services.materializer;
      assert.equal(materializer.environment.XDG_STATE_HOME, runtimeRoot, relative);
      const runtimeMount = materializer.volumes.find((volume) => volume.target === runtimeRoot);
      assert.equal(runtimeMount.source, runtimeRoot, relative);
      assert.equal(runtimeMount.read_only, true, relative);
    }
  }
});

test('a repeated deploy places tracked config and converges once', async () => {
  const r = await runDeploy({
    liveCompose: fs.readFileSync(TRACKED_COMPOSE, 'utf8'),
    liveNginx: fs.readFileSync(TRACKED_NGINX, 'utf8'),
    existingMaterializer: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.readLive('compose.yml'), fs.readFileSync(TRACKED_COMPOSE, 'utf8'));
  assert.equal(r.readLive('relay-front/nginx.conf'), fs.readFileSync(TRACKED_NGINX, 'utf8'));
  assert.equal(
    r
      .sudoLog()
      .split('\n')
      .filter((l) => l.includes('install') && l.includes('compose.yml')).length,
    1,
    r.sudoLog(),
  );
  assert.equal(
    r
      .dockerLog()
      .split('\n')
      .filter((l) => l.includes('compose ') && l.includes('up -d') && !l.includes('--no-deps auth'))
      .length,
    1,
  );
  const dockerOperations = r.dockerLog().trim().split('\n');
  const currentStop = dockerOperations.findIndex((line) => line === 'docker stop gwcontainerid');
  const materializerStart = dockerOperations.findIndex((line) => line.includes('up -d'));
  assert.notEqual(currentStop, -1, r.dockerLog());
  assert.ok(currentStop < materializerStart, r.dockerLog());
  assert.equal(
    r
      .dockerLog()
      .split('\n')
      .filter((l) => l.includes('kill -s HUP')).length,
    1,
  );
});

test('cutover refuses to start while any previous tail owner remains running', async () => {
  const r = await runDeploy({ stickyPushGateway: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.materializerRunning(), false);
  assert.ok(r.stderr.includes('push-gateway containers remain running'), r.stderr);
  assert.equal(
    r
      .dockerLog()
      .split('\n')
      .some((line) => line.includes('compose ') && line.includes('up -d')),
    false,
    r.dockerLog(),
  );
});

test('a failed cutover stops one-way and prints exact forward recovery commands', async () => {
  const r = await runDeploy({ failComposeUp: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.readLive('compose.yml'), fs.readFileSync(TRACKED_COMPOSE, 'utf8'));
  assert.equal(r.readLive('relay-front/nginx.conf'), fs.readFileSync(TRACKED_NGINX, 'utf8'));
  assert.equal(r.eventsRunning(), false);
  assert.equal(r.materializerRunning(), false);
  assert.ok(r.stderr.includes('MANUAL RECOVERY REQUIRED'), r.stderr);
  assert.ok(r.stderr.includes('Keep beeline-events.service stopped'), r.stderr);
  assert.ok(r.stderr.includes('up -d --remove-orphans'), r.stderr);
  assert.ok(r.stderr.includes('/push/health'), r.stderr);
  assert.ok(r.stderr.includes('/workspaces'), r.stderr);
});

test('failed public verification leaves the materializer as sole tail owner', async () => {
  const r = await runDeploy({ failPublic: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.materializerRunning(), true);
  assert.equal(r.eventsRunning(), false);
  assert.equal(r.readLive('compose.yml'), fs.readFileSync(TRACKED_COMPOSE, 'utf8'));
  assert.ok(r.stderr.includes('MANUAL RECOVERY REQUIRED'), r.stderr);
  assert.equal(r.sudoLog().includes('enable --now beeline-events.service'), false, r.sudoLog());
});

test('compose validation never resolves real env_file secrets: an unreadable env_file entry does not fail the deploy', async () => {
  // chmod-000 file even its owner cannot read — stands in for the runner
  // hitting /home/lunchbox/buzzy-auth/oidc.env (run 32615214417). The stubbed
  // docker resolves env_file entries as the invoking user, so validating the
  // UNtransformed compose would fail right here.
  const secretDir = mkdtemp();
  const secret = path.join(secretDir, 'oidc.env');
  fs.writeFileSync(secret, 'OIDC_CLIENT_SECRET=x\n');
  fs.chmodSync(secret, 0o000);
  try {
    const variant = fs
      .readFileSync(TRACKED_COMPOSE, 'utf8')
      .replace('- /home/lunchbox/buzzy-auth/oidc.env', `- ${secret}`);
    assert.ok(variant.includes(secret), 'fixture must actually reference the unreadable file');
    const r = await runDeploy({ liveCompose: variant });
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.ok(r.stdout.includes('production stack rolled out'));
    // The transformation was validation-only: the DEPLOYED compose carries
    // the repo's real env_file reference (deployed bytes converge to the
    // tracked file, never to the pre-deploy live variant).
    assert.equal(r.readLive('compose.yml'), fs.readFileSync(TRACKED_COMPOSE, 'utf8'));
  } finally {
    fs.chmodSync(secret, 0o644);
  }
});

// ---------------------------------------------------------------------------
// Bind-mount inode regression (#fm/beeline-mount-inode).
//
// deploy-relay-host.sh places nginx.conf through fixed-argument
// `sudo install ...`, which REPLACES the destination's inode whenever
// relay-front holds an active single-file bind-mount of that exact file
// (verified empirically: bare-file install truncates in place, but under a
// live file bind it unlinks and recreates). Docker single-file binds pin the
// INODE at container creation, so the container kept reading an orphaned
// pre-deploy inode and every HUP reload silently re-applied stale bytes.
//
// The fix makes prod compose.yml bind the whole ./relay-front DIRECTORY (the
// pattern the web tree in the same container always used), which tracks
// member files across inode replacement.
// ---------------------------------------------------------------------------

function relayFrontRuntimeModel() {
  const relayFront = composeConfig('relay-stack/prod/compose.yml').services['relay-front'];
  return {
    command: relayFront.command,
    mounts: relayFront.volumes.map((volume) => ({
      type: volume.type,
      source: volume.source,
      containerPath: volume.target,
      mode: volume.read_only ? 'ro' : 'rw',
    })),
  };
}

test('relay-front loads nginx.conf through the enclosing read-only directory mount', () => {
  const { command, mounts } = relayFrontRuntimeModel();

  const configMount = mounts.find((mount) => mount.containerPath === '/etc/beeline-front');
  assert.deepEqual(
    configMount,
    {
      type: 'bind',
      source: path.join(REPO, 'relay-stack/prod/relay-front'),
      containerPath: '/etc/beeline-front',
      mode: 'ro',
    },
    'relay-front must bind the enclosing config directory read-only; binding nginx.conf itself pins its old inode',
  );

  assert.ok(
    Array.isArray(command),
    'relay-front must pin a command[] loading config via -c from a directory mount',
  );
  const cFlag = command.indexOf('-c');
  assert.notEqual(cFlag, -1, 'relay-front command must carry a -c flag');
  const configPath = command[cFlag + 1];
  assert.ok(
    configPath.startsWith(configMount.containerPath + '/'),
    `nginx -c path ${configPath} must live inside ${configMount.containerPath}`,
  );
});

test(
  'nginx HUP reloads current bytes after deploy placement through the deployed directory mount',
  { skip: !dockerAvailable() },
  async (t) => {
    const model = relayFrontRuntimeModel();
    const cFlag = model.command.indexOf('-c');
    const containerConfigPath = model.command[cFlag + 1];

    const proj = mkdtemp();
    t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
    const mounts = model.mounts.map((mount) => ({
      ...mount,
      source: path.join(proj, mount.containerPath.replace(/^\/+/, '').replaceAll('/', '-')),
    }));
    for (const mount of mounts) fs.mkdirSync(mount.source, { recursive: true });
    const hostFor = (containerPath) => {
      const m = mounts.find(
        (x) => containerPath === x.containerPath || containerPath.startsWith(x.containerPath + '/'),
      );
      assert.ok(m, `no declared mount covers ${containerPath}`);
      const rel = path.relative(m.containerPath, containerPath);
      return rel && rel !== '.' ? path.join(m.source, rel) : m.source;
    };

    const config = (marker) =>
      `events {}\nhttp { server { listen 3000; location = /m { return 200 "${marker}\\n"; } } }\n`;
    const hostConf = hostFor(containerConfigPath);
    fs.mkdirSync(path.dirname(hostConf), { recursive: true });
    fs.writeFileSync(hostConf, config('V1'));

    const suffix = `${process.pid}-${path.basename(proj).replace(/[^a-z0-9]/gi, '')}`;
    const staleName = `beeline-inode-file-${suffix}`;
    const fixedName = `beeline-inode-dir-${suffix}`;
    const running = new Set();
    t.after(async () => {
      await Promise.all([...running].map((name) => docker(['rm', '-f', name]).catch(() => {})));
    });

    // Disconfirm "HUP is broken" and "the candidate config is invalid": an
    // in-place write keeps the inode, and a file-bound nginx reloads V2.
    await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      staleName,
      '-v',
      `${hostConf}:/etc/nginx/nginx.conf:ro`,
      'nginx:1.27-alpine',
    ]);
    running.add(staleName);
    await waitForMarker(staleName, 'V1');
    const originalInode = fs.statSync(hostConf).ino;
    fs.writeFileSync(hostConf, config('V2'));
    assert.equal(
      fs.statSync(hostConf).ino,
      originalInode,
      'in-place write must preserve the source inode',
    );
    await docker(['kill', '-s', 'HUP', staleName]);
    await waitForMarker(staleName, 'V2');

    // Initiating trigger + visible symptom: install replaces the source inode;
    // HUP succeeds, but the file-bound nginx keeps serving the old V2 bytes.
    const stagedV3 = path.join(proj, 'staged-v3.nginx.conf');
    fs.writeFileSync(stagedV3, config('V3'));
    await installFile(stagedV3, hostConf);
    assert.notEqual(
      fs.statSync(hostConf).ino,
      originalInode,
      'install must replace the source inode for this reproduction',
    );
    await docker(['kill', '-s', 'HUP', staleName]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await nginxMarker(staleName),
      'V2\n',
      'single-file bind must reproduce the stale nginx response',
    );
    await docker(['rm', '-f', staleName]);
    running.delete(staleName);

    // Smallest counterfactual: keep install + HUP unchanged and carry exactly
    // the declared production binds/command. Whether install preserves or
    // replaces the member inode, directory lookup lets nginx reload V4.
    const bindArgs = mounts.flatMap((m) => ['-v', `${m.source}:${m.containerPath}:${m.mode}`]);
    await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      fixedName,
      ...bindArgs,
      'nginx:1.27-alpine',
      ...model.command,
    ]);
    running.add(fixedName);
    await waitForMarker(fixedName, 'V3');
    const stagedV4 = path.join(proj, 'staged-v4.nginx.conf');
    fs.writeFileSync(stagedV4, config('V4'));
    await installFile(stagedV4, hostConf);
    assert.equal(
      fs.readFileSync(hostConf, 'utf8'),
      config('V4'),
      'deploy placement must update the host config',
    );
    await docker(['kill', '-s', 'HUP', fixedName]);
    await waitForMarker(fixedName, 'V4');

    // Stronger check: even an explicit atomic replacement changes the member
    // inode without orphaning a directory bind. HUP still loads V5.
    const directoryVisibleInode = fs.statSync(hostConf).ino;
    const stagedV5 = path.join(proj, 'staged-v5.nginx.conf');
    fs.writeFileSync(stagedV5, config('V5'));
    fs.renameSync(stagedV5, hostConf);
    assert.notEqual(
      fs.statSync(hostConf).ino,
      directoryVisibleInode,
      'atomic replacement must change the member inode',
    );
    await docker(['kill', '-s', 'HUP', fixedName]);
    await waitForMarker(fixedName, 'V5');
  },
);

function installFile(source, destination) {
  return new Promise((resolve, reject) => {
    const p = spawn('install', [
      '-o',
      String(process.getuid()),
      '-g',
      String(process.getgid()),
      '-m',
      '644',
      source,
      destination,
    ]);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`install exited ${code}`))));
  });
}

async function nginxMarker(container) {
  return dockerOutput(['exec', container, 'wget', '-qO-', 'http://127.0.0.1:3000/m']);
}

async function waitForMarker(container, marker) {
  let last = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      last = await nginxMarker(container);
      if (last === `${marker}\n`) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(last, `${marker}\n`, `nginx in ${container} never served ${marker}`);
}

// Synchronous so it can gate node:test's static `skip` option: the semantic
// proof below needs a real daemon (bind-mount semantics cannot be stubbed),
// and environments without docker take the skip rather than a failure.
function dockerAvailable() {
  try {
    return spawnSync('docker', ['info', '--format', 'ok'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function docker(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker ${args.join(' ')} exited ${code}`)),
    );
  });
}

function dockerOutput(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    p.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`docker ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}
