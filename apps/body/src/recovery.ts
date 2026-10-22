import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requestMachine } from './machine-control.js';
import {
  convergeNativeHelper,
  nativeHelperStatus,
  nativeSupervisor,
  type NativeRunner,
} from './native-helper.js';
import { prepareReleaseInWorker, versionAtLeast, withInstallLock } from './managed-update.js';
import {
  activeReleaseId,
  activateRelease,
  discoveredBeelineInstallLayout,
  beelineInstallLayout,
  prepareLatestRelease,
  readUpdateState,
  readInstalledBundleIdentity,
  resolveBundleEntrypoint,
  type BeelineInstallLayout,
} from './self-update.js';
import type { HelperStatusFile } from './helper-status.js';
import { assertLifecycleTestIsolation } from './lifecycle-test-guard.js';

export async function prepareMachineRelease(
  layout: BeelineInstallLayout,
  options: Parameters<typeof prepareLatestRelease>[1] = {},
) {
  const deadlineAt = Math.min(options?.deadlineAt ?? Infinity, Date.now() + 180_000);
  const env: NodeJS.ProcessEnv = {
    ...(options?.env ?? process.env),
    BEELINE_LIB_DIR: layout.libDir,
  };
  if (options?.fetchImpl || env.BEELINE_LAB === '1')
    return withInstallLock(layout, () => prepareLatestRelease(layout, { ...options, deadlineAt }), {
      waitMs: Math.max(0, deadlineAt - Date.now()),
    });
  const stable = resolve(layout.libDir, '../beeline-bootstrap.mjs');
  const entrypoint =
    env.BEELINE_RECOVERY_ENTRY ||
    (await readFile(stable).then(
      () => stable,
      () => process.argv[1],
    ));
  return prepareReleaseInWorker(
    { ...env, ...(options?.force ? { BEELINE_FORCE_REPAIR: '1' } : {}) },
    deadlineAt,
    entrypoint,
  );
}

/** Every mutating entry converges service even when verified content is reused. */
export async function convergeMachine(
  options: {
    env?: NodeJS.ProcessEnv;
    layout?: BeelineInstallLayout;
    releaseId?: string;
    run?: NativeRunner;
    timeoutMs?: number;
    agentIds?: string[];
    deadlineAt?: number;
  } = {},
): Promise<HelperStatusFile> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  const layout = options.layout ?? beelineInstallLayout(env) ?? discoveredBeelineInstallLayout(env);
  const deadlineAt = options.deadlineAt ?? Date.now() + (options.timeoutMs ?? 600_000);
  const stateRoot = env.XDG_STATE_HOME || resolve(env.HOME || '', '.local/state');
  const root = resolve(stateRoot, 'beeline/agents');
  const configured = await Promise.all(
    (await readdir(root).catch(() => []))
      .filter((id) => /^[0-9a-f]{64}$/i.test(id))
      .map(async (id) =>
        (await stat(resolve(root, id, 'runtime.json')).then(
          () => true,
          () => false,
        )) &&
        !(await stat(resolve(root, id, 'stopped')).then(
          () => true,
          () => false,
        ))
          ? id
          : undefined,
      ),
  );
  const required = new Set([
    ...configured.filter((id): id is string => Boolean(id)),
    ...(options.agentIds ?? []),
  ]);
  const current = await requestMachine(stateRoot, { operation: 'status' }, () => true, 1000).catch(
    () => undefined,
  );
  const hasControl = Boolean(current);
  // Repair current-release anchors and forwarders even while its body is live.
  // A different prepared release still waits for the machine's drain handoff.
  if (options.releaseId && (!hasControl || current?.loadedRelease === options.releaseId))
    await withInstallLock(layout, () => activateRelease(layout, options.releaseId!), {
      waitMs: Math.max(0, deadlineAt - Date.now()),
    });
  await convergeNativeHelper({
    env: { ...env, BEELINE_LIB_DIR: layout.libDir },
    ...(options.run ? { run: options.run } : {}),
    // A pre-control helper cannot acknowledge this protocol. Its first forward migration replaces it once.
    restart: !hasControl,
    deadlineAt,
  });
  let expectedRelease = options.releaseId;
  const targetIdentity = options.releaseId
    ? await readInstalledBundleIdentity({
        ...layout,
        libDir: resolve(layout.releasesRoot, options.releaseId),
      })
    : undefined;
  const request =
    options.releaseId && hasControl
      ? {
          operation: 'update' as const,
          releaseId: options.releaseId,
          sourceGeneration: current!.generation,
        }
      : { operation: 'converge' as const };
  return requestMachine(
    stateRoot,
    request,
    (status) => {
      if (status.generation === current?.generation && status.desiredRelease)
        expectedRelease = status.desiredRelease;
      if (
        expectedRelease &&
        status.loadedRelease !== expectedRelease &&
        !(
          targetIdentity?.version &&
          status.loadedIdentity?.version &&
          targetIdentity.version !== status.loadedIdentity.version &&
          versionAtLeast(status.loadedIdentity.version, targetIdentity.version)
        )
      )
        return false;
      const agents = Object.entries(status.agents).filter(
        ([id, agent]) => required.has(id) || agent.enabled !== false,
      );
      const refused = agents.filter(
        ([, agent]) =>
          agent.state === 'needs-auth' ||
          agent.state === 'needs-config' ||
          agent.state === 'removed',
      );
      if (refused.length)
        throw new Error(refused.map(([id, agent]) => `agent ${id}: ${agent.status}`).join('; '));
      if ([...required].some((id) => !status.agents[id] || status.agents[id]?.enabled === false))
        return false;
      return (
        status.processState === 'serving' && agents.every(([, agent]) => agent.state === 'serving')
      );
    },
    Math.max(1, deadlineAt - Date.now()),
  ).catch((error) => {
    throw new Error(
      `${String(error)}${required.size ? `; enabled agents: ${[...required].join(', ')}` : ''}`,
    );
  });
}

/** Native manager starts the independent bootstrap; the selected body never owns freshness at boot. */
export async function bootstrapMachine(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const bootDeadlineAt = Date.now() + 240_000;
  nativeSupervisor(env);
  const native = await nativeHelperStatus(env);
  const pid = Number(native.MainPID ?? native.pid);
  if (
    !pid ||
    ![Number(env.BEELINE_BOOT_LAUNCHER_PID), Number(env.BEELINE_BOOT_LAUNCHER_PARENT_PID)].includes(
      pid,
    )
  )
    throw new Error('helper bootstrap requires native service ownership; run beeline start');
  const layout = beelineInstallLayout(env) ?? discoveredBeelineInstallLayout(env);
  // The serving predecessor already verified the staged successor. Never put
  // publication/download work on the outage path; MachineLink checks freshness
  // after registration while Room intake is open.
  const state = await readUpdateState(layout);
  const active = await activeReleaseId(layout);
  let releaseId: string | undefined;
  for (const id of [state.stagedReleaseId, active]) {
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) continue;
    const digest = await readFile(resolve(layout.releasesRoot, id, '.stage-ok'), 'utf8').catch(() => '');
    if (/^[0-9a-f]{64}$/i.test(digest.trim()) &&
        await resolveBundleEntrypoint(resolve(layout.releasesRoot, id))) {
      releaseId = id;
      break;
    }
  }
  if (!releaseId) {
    // Recovery of a missing/broken install still prepares before importing code.
    releaseId = (await prepareMachineRelease(layout, {
      env, deadlineAt: Date.now() + 180_000, logger: line => console.error(line),
    })).releaseId;
  }
  if (releaseId !== active)
    await withInstallLock(layout, () => activateRelease(layout, releaseId!, { deferPruning: true }), {
      waitMs: Math.max(0, bootDeadlineAt - Date.now()),
    });
  const entry = await resolveBundleEntrypoint(resolve(layout.releasesRoot, releaseId));
  if (!entry) throw new Error(`selected release ${releaseId} has no body entry`);
  return entry;
}
