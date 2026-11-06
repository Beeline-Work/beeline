import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import {
  RELEASE_COMPONENTS,
  changedPathsFromPublishedInputs,
  initializeRelease,
  planOutputs,
  selectReleaseComponents,
  selectReleaseComponentsFromPublishedInputs,
} from './unified-release.mjs';

const previousSha = 'a'.repeat(40);
const releaseSha = 'b'.repeat(40);
const componentPaths = (paths = []) => Object.fromEntries(RELEASE_COMPONENTS.map(component => [component, paths]));
const publishedRelease = () => {
  const previous = initializeRelease({ version: 'v0.1.162', sourceSha: previousSha });
  previous.state = 'delivered';
  for (const entry of Object.values(previous.components)) entry.state = 'checked';
  return previous;
};

for (const path of [
  'apps/mobile/sources/components/buzz/room-list-row.ts',
  'apps/mobile/assets/icon.png',
  'packages/api-contract/src/index.ts',
  'packages/buzz-client/src/index.ts',
  'packages/nostr/src/index.ts',
  'packages/net/src/route-codecs.ts',
  'apps/mobile/index.ts',
  'apps/mobile/metro.config.js',
  'apps/mobile/babel.config.js',
  'apps/mobile/public/canvaskit.wasm',
  'apps/mobile/patches/@expo+vector-icons+15.1.1.patch',
  'apps/mobile/scripts/patch-livekit-abort.cjs',
  'apps/mobile/scripts/patch-livekit-owned.cjs',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'apps/mobile/app.config.js',
  'apps/mobile/package.json',
  'apps/mobile/package-lock.json',
  'apps/mobile/src-tauri/src/lib.rs',
  'apps/mobile/src-tauri/Cargo.lock',
  'apps/mobile/src-tauri/tauri.conf.json',
]) {
  test(`desktop rebuilds immediately for its bundled input: ${path}`, () => {
    assert.ok(selectReleaseComponents([path]).includes('desktop'));
    const previous = publishedRelease();
    const selectedComponents = selectReleaseComponentsFromPublishedInputs(componentPaths([path]));
    const state = initializeRelease({ version: 'v0.1.163', sourceSha: releaseSha, previous, selectedComponents });
    assert.match(planOutputs(state, previous), /^run_desktop=true$/m);
    assert.equal(state.components.desktop.sourceSha, releaseSha);
    assert.notEqual(state.components.desktop.desktopVersion, previous.components.desktop.desktopVersion);
  });
}

for (const paths of [[], ['apps/server/src/index.ts'], ['web/index.html']]) {
  test(`desktop carries its published build when bundled inputs are unchanged: ${JSON.stringify(paths)}`, () => {
    const previous = publishedRelease();
    const selectedComponents = selectReleaseComponentsFromPublishedInputs(componentPaths(paths));
    assert.equal(selectedComponents.includes('desktop'), false);
    const state = initializeRelease({ version: 'v0.1.163', sourceSha: releaseSha, previous, selectedComponents });
    assert.match(planOutputs(state, previous), /^run_desktop=false$/m);
    assert.equal(state.components.desktop.sourceSha, previous.components.desktop.sourceSha);
    assert.equal(state.components.desktop.artifactRef, previous.components.desktop.artifactRef);
    assert.equal(state.components.desktop.desktopVersion, previous.components.desktop.desktopVersion);
    if (paths[0]?.startsWith('apps/server/')) assert.deepEqual(selectedComponents, ['server']);
  });
}

test('desktop compares against its own published source even when the other components are current', () => {
  const previous = publishedRelease();
  previous.sourceSha = releaseSha;
  for (const [component, entry] of Object.entries(previous.components)) {
    if (component !== 'desktop') entry.sourceSha = releaseSha;
  }
  const paths = changedPathsFromPublishedInputs(previous, releaseSha, {
    gitDiff: publishedSha => publishedSha === previousSha ? 'apps/mobile/sources/app/index.tsx\n' : '',
  });
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(paths), ['desktop']);
});

test('explicit recovery selection still controls which components rebuild', () => {
  const paths = componentPaths(['apps/mobile/sources/app/index.tsx']);
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(paths, { selection: 'server' }), ['server']);
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(componentPaths(), { selection: 'desktop' }), ['desktop']);
});

// The free-agent image must use the release's existing rollout; publishing
// after completion used to restart every server a second time and drop phones.
test('free-agent image publication stages its digest before the sole server rollout', () => {
  assert.equal(existsSync('.github/workflows/free-agent-image.yml'), false);
  const workflow = parse(readFileSync('.github/workflows/unified-release.yml', 'utf8'));
  const steps = parse(readFileSync('.github/actions/server-leg/action.yml', 'utf8')).runs.steps;
  const publish = steps.findIndex(step => step.id === 'free_agent_image');
  const stage = steps.findIndex(step => step.name?.startsWith('Stage the free starter'));
  const rollout = steps.findIndex(step => step.name?.startsWith('Canary one Machine'));
  const verify = steps.findIndex(step => step.name?.startsWith('Verify the free starter image'));
  assert.ok(publish < stage && stage < rollout && rollout < verify);
  for (const index of [publish, stage, verify]) assert.equal(steps[index].if, "steps.fleet.outputs.shipped != 'true'");
  const updates = steps.filter(step => /flyctl machine update/.test(step.run ?? ''));
  assert.equal(updates.length, 1);
  assert.equal(updates[0], steps[rollout]);
  assert.match(steps[publish].run, /--build-only --push/);
  const call = workflow.jobs.server.steps.find(step => step.uses === './.github/actions/server-leg');
  assert.equal(call.with.free_agent_image_token, '${{ secrets.FLY_FREE_AGENT_IMAGE_TOKEN }}');

  const root = mkdtempSync(join(tmpdir(), 'beeline-image-stage-'));
  try {
    mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/stage-free-agent-helper.sh'), 'exit 0\n');
    const image = `registry.fly.io/beeline-free-agents:1.2.3-${releaseSha.slice(0, 12)}@sha256:${'c'.repeat(64)}`;
    writeFileSync(join(root, 'bin/docker'), `#!/bin/sh\nprintf '%s\\n' '{"Descriptor":{"digest":"sha256:${'c'.repeat(64)}"}}'\n`, { mode: 0o755 });
    writeFileSync(join(root, 'bin/flyctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  'machine list') printf '%s\\n' '[{"id":"one","state":"started"},{"id":"two","state":"started"}]' ;;
  'machine exec') if [ "$6" = 'printenv FLY_FREE_AGENT_IMAGE' ]; then printf '%s\\n' "\${ACTUAL_IMAGE:-$IMAGE_REF}"; fi ;;
esac
`, { mode: 0o755 });
    const output = join(root, 'output');
    const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RUNNER_TEMP: root,
      RELEASE_SHA: releaseSha, RELEASE_VERSION: 'v1.2.3', GITHUB_OUTPUT: output,
      IMAGE_REF: image, CALLS: join(root, 'calls') };
    execFileSync('bash', ['-c', steps[publish].run], { cwd: root, env });
    assert.equal(readFileSync(output, 'utf8').trim(), `image_ref=${image}`);
    execFileSync('bash', ['-c', steps[stage].run], { cwd: root, env });
    mkdirSync(join(root, 'server-release'));
    execFileSync('bash', ['-c', steps[verify].run], { cwd: root, env });
    const calls = readFileSync(env.CALLS, 'utf8');
    assert.match(calls, /secrets set --app beeline-server --stage FLY_FREE_AGENT_IMAGE=registry/);
    assert.equal(calls.includes('machine update'), false);
    assert.match(calls, /machine exec one --app beeline-server printenv FLY_FREE_AGENT_IMAGE/);
    assert.match(calls, /machine exec two --app beeline-server printenv FLY_FREE_AGENT_IMAGE/);
    assert.match(calls, /--refresh-free-agents/);
    assert.throws(() => execFileSync('bash', ['-c', steps[verify].run], {
      cwd: root, env: { ...env, ACTUAL_IMAGE: 'older-image' }, stdio: 'pipe',
    }), /Command failed/);
    assert.equal(readFileSync(env.CALLS, 'utf8').includes('machine update'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
