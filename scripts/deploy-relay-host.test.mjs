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
import { spawn } from 'node:child_process';
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
// untracked): the tracked copies must converge them to the push-gateway
// shape. We only need a marker difference, but using the REAL pre-change
// content keeps the first-rollout scenario honest.
const PRE_CHANGE_COMPOSE = fs.readFileSync(TRACKED_COMPOSE, 'utf8')
  .replace('beeline-push-gateway:production', 'beeline-push-gateway:OLD')
  .replace(/# nginx resolves proxy_pass upstreams[\s\S]*?condition: service_healthy\n/, '');
const PRE_CHANGE_NGINX = fs.readFileSync(TRACKED_NGINX, 'utf8')
  .replace('http://push-gateway:8788/', 'http://push-host:8788/');

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
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--filter" ] && echo "$a" | grep -q "service=push-gateway" && [ -f "$STATE/gateway-running" ]; then
        echo "gwcontainerid"
      fi
      if [ "$prev" = "--filter" ] && echo "$a" | grep -q "service=relay-front"; then
        echo "frontcontainerid"
      fi
      prev="$a"
    done
    ;;
  network)
    ;;
  run)
    ;;
  kill)
    log "kill $*"
    ;;
  compose)
    log "compose $*"
    # Only a FULL-stack up can be made to fail; the pre-existing auth-only
    # recreation always succeeds.
    case "$*" in
      *"up -d --no-deps auth") ;;
      *"up -d"*)
        if [ -f "$STATE/fail-compose-up" ]; then
          echo "simulated compose up failure" >&2
          exit 1
        fi
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
    if [ -f "$STATE/fail-install" ]; then echo "simulated install failure" >&2; exit 1; fi
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
      " up -d") exec __BIN__/docker compose -p buzz-router-prod up -d ;;
      " up -d --no-deps auth") exec __BIN__/docker compose -p buzz-router-prod up -d --no-deps auth ;;
      *) echo "sudoers REFUSAL (compose args):$rest" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "sudoers REFUSAL (command)" >&2; exit 1
    ;;
esac
`;
  write(path.join(binDir, 'docker'), docker.replaceAll('__STATE__', stateDir).replaceAll('__BIN__', binDir));
  write(path.join(binDir, 'sudo'), sudo.replaceAll('__STATE__', stateDir).replaceAll('__BIN__', binDir));
  fs.chmodSync(path.join(binDir, 'docker'), 0o755);
  fs.chmodSync(path.join(binDir, 'sudo'), 0o755);
}

async function withPublicServer(fn) {
  const server = http.createServer((req, res) => {
    const serve = (file) => {
      try {
        res.end(fs.readFileSync(file));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    };
    if (req.url === '/install') serve(path.join(REPO, 'relay-stack/web/install.sh'));
    else if (req.url === '/dl/manifest.json') serve(path.join(REPO, 'relay-stack/web/dl/manifest.json'));
    else if (req.url?.startsWith('/dl/') && req.url.endsWith('.sha256')) serve(path.join(REPO, 'relay-stack/web/dl', req.url.slice(4)));
    else if (req.url?.startsWith('/dl/')) serve(path.join(REPO, 'relay-stack/web/dl', req.url.slice(4)));
    else if (req.url?.startsWith('/.well-known/')) { res.statusCode = 200; res.end('{}'); }
    else if (req.url === '/auth/capabilities') { res.statusCode = 200; res.end('{}'); }
    else if (req.url === '/push/health') { res.statusCode = 200; res.end('ok'); }
    else { res.statusCode = 404; res.end(); }
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
  write(path.join(proj, '.env'), 'POSTGRES_PASSWORD=real-secret\nREDIS_PASSWORD=real\nBUZZ_S3_ACCESS_KEY=k\nBUZZ_S3_SECRET_KEY=s\n');
  if (opts.gatewayRunning) write(path.join(stateDir, 'gateway-running'), '1');
  if (opts.failComposeUp) write(path.join(stateDir, 'fail-compose-up'), '1');
  if (opts.failInstall) write(path.join(stateDir, 'fail-install'), '1');

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
          BEELINE_STACK_STAGE_DIR: path.join(tmp, 'stage'),
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
    });
    closeServer();
    if (process.env.DEBUG_DEPLOY_TEST) {
      fs.writeFileSync('/tmp/deploy-test-debug.log', `STATUS ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\n`);
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      proj,
      tmp,
      stateDir,
      readLive: (rel) => fs.readFileSync(path.join(proj, rel), 'utf8'),
      sudoLog: () => (fs.existsSync(path.join(stateDir, 'sudo.log')) ? fs.readFileSync(path.join(stateDir, 'sudo.log'), 'utf8') : ''),
      dockerLog: () => (fs.existsSync(path.join(stateDir, 'docker.log')) ? fs.readFileSync(path.join(stateDir, 'docker.log'), 'utf8') : ''),
    };
  });
}

test('first rollout installs both config files, runs one full `up -d`, HUP-reloads nginx, and backs up what it replaced', async () => {
  const r = await runDeploy({});
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.equal(r.readLive('compose.yml'), fs.readFileSync(TRACKED_COMPOSE, 'utf8'));
  assert.equal(r.readLive('relay-front/nginx.conf'), fs.readFileSync(TRACKED_NGINX, 'utf8'));

  // Exactly one FULL-stack up through sudo; the pre-existing auth-only
  // recreation (`up -d --no-deps auth`) still happens and is fine.
  const ups = r.dockerLog().split('\n').filter((l) => l.includes('compose ') && l.includes('up -d') && !l.includes('--no-deps auth'));
  assert.equal(ups.length, 1, r.dockerLog());
  assert.ok(ups[0].includes('-p buzz-router-prod'));
  assert.ok(!ups[0].includes('--no-deps auth'));
  assert.ok(r.sudoLog().includes('up -d'));

  // nginx HUP reload happened exactly once.
  assert.equal(r.dockerLog().split('\n').filter((l) => l.includes('kill -s HUP')).length, 1);

  // Backups of BOTH replaced files, timestamped beside the web backups.
  const backupRoot = path.join(r.proj, 'relay-front/web-backups');
  const cfgBaks = fs.readdirSync(backupRoot).filter((d) => d.startsWith('config-'));
  assert.equal(cfgBaks.length, 1);
  assert.equal(fs.readFileSync(path.join(backupRoot, cfgBaks[0], 'compose.yml'), 'utf8'), PRE_CHANGE_COMPOSE);
  assert.equal(fs.readFileSync(path.join(backupRoot, cfgBaks[0], 'relay-front/nginx.conf'), 'utf8'), PRE_CHANGE_NGINX);
});

test('a config-unchanged merge is an idempotent no-op: no install, no compose up, no restart', async () => {
  const tracked = fs.readFileSync(TRACKED_COMPOSE, 'utf8');
  const r = await runDeploy({
    liveCompose: tracked,
    liveNginx: fs.readFileSync(TRACKED_NGINX, 'utf8'),
    gatewayRunning: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('production stack unchanged'));
  assert.ok(!r.sudoLog().includes('install'), r.sudoLog());
  assert.equal(
    r.sudoLog().split('\n').filter((l) => l.includes('up -d') && !l.includes('--no-deps auth')).length,
    0,
    r.sudoLog(),
  );
  assert.ok(!r.dockerLog().startsWith('kill '), r.dockerLog());
});

test('an nginx-content-only change places just nginx.conf and reloads via HUP without any compose up', async () => {
  const r = await runDeploy({
    liveCompose: fs.readFileSync(TRACKED_COMPOSE, 'utf8'),
    gatewayRunning: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.readLive('relay-front/nginx.conf'), fs.readFileSync(TRACKED_NGINX, 'utf8'));
  assert.ok(r.sudoLog().includes('nginx.conf'));
  // No compose.yml was placed (the auth step's `-f .../compose.yml` line is
  // not an install).
  assert.equal(r.sudoLog().split('\n').filter((l) => l.includes('install') && l.includes('compose.yml')).length, 0, r.sudoLog());
  assert.equal(r.dockerLog().split('\n').filter((l) => l.startsWith('compose ') && l.includes('up -d') && !l.includes('--no-deps auth')).length, 0);
  assert.equal(r.dockerLog().split('\n').filter((l) => l.includes('kill -s HUP')).length, 1);
});

test('a failed stack rollout restores the previous config files and fails the deploy WITHOUT losing the web deploy', async () => {
  const r = await runDeploy({ failComposeUp: true });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('STACK ROLLOUT FAILED'), r.stderr);
  // Config files rolled back to their pre-deploy bytes.
  assert.equal(r.readLive('compose.yml'), PRE_CHANGE_COMPOSE);
  assert.equal(r.readLive('relay-front/nginx.conf'), PRE_CHANGE_NGINX);
  // The web deploy still completed and verified (web swap succeeded — the
  // staged tree mirrors the checkout's web/).
  assert.equal(
    r.readLive('relay-front/web/install.sh'),
    fs.readFileSync(path.join(REPO, 'relay-stack/web/install.sh'), 'utf8'),
  );
});

test('a refused sudo install (missing sudoers rule) fails loudly and rolls the config back', async () => {
  const r = await runDeploy({ failInstall: true });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('STACK ROLLOUT FAILED'), r.stderr);
  assert.equal(r.readLive('compose.yml'), PRE_CHANGE_COMPOSE);
});
