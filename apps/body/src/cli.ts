#!/usr/bin/env node
import { requestMachine } from './machine-control.js';
import { RESOURCE_FACADE_FLAG, runResourceFacade } from './resource-mcp-facade.js';
/**
 * Beeline body CLI — run a body against a TLC channel.
 *
 * Usage:
 *   BUZZ_PRIVATE_KEY=nsec1... \
 *   BUZZ_AGENT_BIN=/path/to/buzz-agent \
 *   BUZZ_DEV_MCP_BIN=/path/to/buzz-dev-mcp \
 *   BUZZY_BODY_LLM_FILE=/path/to/llm-egress.env \
 *   npx tsx src/cli.ts provision <channel-uuid>
 *
 * Or via npm:
 *   npm run body -- provision <channel-uuid>
 *
 * Env-driven config; see BodyConfig for all env overrides.
 */
import './network-family-bootstrap.js';
import { dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { CURSOR_ACP_BRIDGE_FLAG, runCursorAcpStdioServer } from './cursor-acp-bridge.js';
import {
  runSquireBroker,
  runSquireFacade,
  SQUIRE_BROKER_FLAG,
  SQUIRE_FACADE_FLAG,
} from './squire-host.js';
import { runSquireTaskProxy } from './squire-task-relay.js';
import { AGENT_ACCESS_POLICIES, isAgentAccessPolicy } from './access-policy.js';
import { REGISTRY_MCP_BROKER_FLAG, runRegistryMcpBroker } from './registry-mcp.js';
import {
  HELPER_EXIT_CODES,
  installUnhandledRejectionGuard,
  type HelperLifecycle,
  type HelperExitReason,
} from './helper-lifecycle.js';
import { activateDaemonTransport } from './daemon-api-client.js';
import { defaultSupervisorRoot, findAgentRuntimeConfigPaths, readRuntimeRecord, setAgentStopped } from './runtime.js';
import { runCleanupSharedHomeCommand } from './startup-cleanup.js';
import { runStartCommand } from './start-command.js';
import {
  parseConnectSubscriptions,
  runConnectCommand,
  runConnectFinishCommand,
} from './connect-command.js';
import { refreshRuntimeHarnessAdapters, runUpdateCommand } from './self-update-cli.js';
import {
  activeReleaseId,
  beelineInstallLayout,
  describeIdentity,
  readInstalledBundleIdentity,
  repairInstallForwarders,
} from './self-update.js';
import { runManagedUpdateWorker } from './managed-update.js';
import { ensureMachineHelper, reloadMachineHelper } from './helper-service.js';
import { runMachineHelper } from './machine-helper.js';
import { runLeasedEmulator } from './android-emulator-lease.js';

function usage(exitCode = 1): void {
  console.error(`
${pc.bold('Beeline — thin Room agent.')}

${pc.dim('Usage:')}
  beeline connect [XXXXXXXX-XXXXXXXX] [--subscribe <kinds>] [--access <policy>]
                                            Install and connect an app-authorized agent;
                                            --subscribe takes a comma-separated list of
                                            event kinds it reacts to (e.g. joined);
                                            --access is everyone|creator|allowlist
                                            (default creator)
  beeline start                             Update the helper, then have this
                                            machine's one helper process host every
                                            paired agent. Agents it already serves
                                            are left untouched. Reports started,
                                            already running, or failed for each.
  beeline start --agent <agent-pubkey>      Same, for one agent only (undoes stop)
  beeline stop --agent <agent-pubkey>       Stop serving one agent; every other
                                            agent on this machine keeps serving
  beeline update [--check|--status|--force]
                                            Self-update the installed bundle
  beeline cleanup-shared-home [--apply]      Report byte-identical obsolete cache copies;
                                            --apply requires a quiescent helper

${pc.dim('Options:')}
  --workspace-root <path>   Agent workspace (default: ./body-workspace)
  --llm-env-file <path>     Path to LLM credentials env file

All other config via env vars (see config.ts).
`);
  process.exit(exitCode);
}

let daemonLifecycle: HelperLifecycle | undefined;

class DaemonExitError extends Error {
  constructor(
    message: string,
    readonly reason: HelperExitReason,
  ) {
    super(message);
    this.name = 'DaemonExitError';
  }
}

/**
 * A per-agent unit from before the machine helper started this (new) bundle
 * as `daemon --agent <key>`. Hand the agent to the machine helper, retire the
 * per-agent units, and exit after the native manager owns the successor job.
 */
async function migrateLegacyAgentUnit(agentPubkey: string): Promise<never> {
  // Retiring this process's own unit sends it SIGTERM; finish the handoff first.
  process.on('SIGTERM', () => undefined);
  try {
    const helper = await ensureMachineHelper({ selfAgent: agentPubkey });
    console.log(
      `[beeline] agent ${agentPubkey} moved to the machine helper (${helper.supervisor}, pid ${helper.pid})`,
    );
  } catch (error) {
    // Nothing was retired before the helper was running; this unit stays and
    // the service manager tries again.
    throw new DaemonExitError(
      `machine helper did not start: ${error instanceof Error ? error.message : String(error)}`,
      'failed',
    );
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];
  if (command === 'emulator') {
    process.exitCode = await runLeasedEmulator(args.slice(1));
    return;
  }
  if (command === CURSOR_ACP_BRIDGE_FLAG) {
    await runCursorAcpStdioServer();
    return;
  }
  if (command === RESOURCE_FACADE_FLAG) {
    runResourceFacade();
    return;
  }
  if (command === REGISTRY_MCP_BROKER_FLAG) {
    runRegistryMcpBroker();
    return;
  }
  if (command === SQUIRE_FACADE_FLAG) {
    if (process.env.BEELINE_SQUIRE_RELAY_URL) runSquireTaskProxy();
    else await runSquireFacade();
    return;
  }
  if (command === SQUIRE_BROKER_FLAG) {
    await runSquireBroker();
    return;
  }
  if (command === '--help' || command === '-h') usage(0);

  if (command === 'managed-update-worker') {
    if (process.env.BEELINE_INTERNAL_UPDATE_WORKER !== '1') {
      throw new Error('managed-update-worker is an internal command');
    }
    console.log(JSON.stringify(await runManagedUpdateWorker()));
    return;
  }

  if (command === 'converge-dependencies') {
    if (process.env.BEELINE_INTERNAL_RECOVERY !== '1') throw new Error('converge-dependencies is an internal recovery command');
    await refreshRuntimeHarnessAdapters({ env: process.env });
    const layout = beelineInstallLayout(process.env);
    if (!layout) throw new Error('dependency convergence requires an installed layout');
    const invocationPath = resolve(layout.libDir, 'lib/beeline/beeline-cli.mjs');
    try {
      if (process.platform === 'linux') {
        const { installTrustySquireBrokerService } = await import('./systemd.js');
        await installTrustySquireBrokerService({ invocationPath });
      } else if (process.platform === 'darwin') {
        const { installLaunchdTrustySquireBrokerService } = await import('./launchd.js');
        await installLaunchdTrustySquireBrokerService({ invocationPath });
      }
    } catch (error) { console.error(`[beeline] host Squire dependency not converged: ${String(error)}`); }
    return;
  }

  if (command === 'corner-read-token') {
    const configFlag = args.indexOf('--config');
    const roomFlag = args.indexOf('--room');
    const configPath = configFlag >= 0 ? args[configFlag + 1] : undefined;
    const roomId = roomFlag >= 0 ? args[roomFlag + 1] : undefined;
    if (!configPath || !roomId) throw new Error('corner-read-token requires --config and --room');
    const activated = await activateDaemonTransport(resolve(configPath));
    if (!activated) throw new Error('corner-read-token requires monolith transport');
    const credential = await activated.client.execute('getRoomGitHubToken', { roomId });
    process.stdout.write(`${credential.token}\n`);
    return;
  }

  if (command === 'connect') {
    // `--subscribe joined,check-failed`: what this agent reacts to in the
    // Rooms the claim joins it to. A greeter is set up with `--subscribe joined`.
    const subscribeFlag = args.indexOf('--subscribe');
    const subscribe = subscribeFlag >= 0 ? parseConnectSubscriptions(args[subscribeFlag + 1]) : [];
    // `--access everyone`: who may drive this agent. Absent keeps the safe
    // default, where only the person who paired it may. A Room's greeter needs
    // `everyone`, because the people it greets are never its creator.
    const accessFlag = args.indexOf('--access');
    const accessPolicy = accessFlag >= 0 ? args[accessFlag + 1] : undefined;
    if (accessFlag >= 0 && !isAgentAccessPolicy(accessPolicy)) {
      throw new Error(`--access must be one of ${AGENT_ACCESS_POLICIES.join(', ')}`);
    }
    const code = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    await runConnectCommand(code, {
      ...(subscribe.length ? { subscribe } : {}),
      ...(isAgentAccessPolicy(accessPolicy) ? { accessPolicy } : {}),
    });
    return;
  }

  if (command === 'connect-finish') {
    await runConnectFinishCommand(args[1]);
    return;
  }

  // Heal <prefix>/bin forwarders left broken by pre-contract installs (see
  // self-update.ts, "THE CONTRACT"): a daemon that survived the layout drift
  // starts through node directly, so it — and every CLI command run on a
  // healthy install — gets a free chance to make fresh-shell invocations work
  // again. Best-effort; never blocks or fails a command.
  const startupLayout = beelineInstallLayout(process.env);
  if (startupLayout) {
    await repairInstallForwarders(startupLayout).catch(() => undefined);
  }

  // Every command below shares this: a real terminal on both ends gets clack
  // framing (intro/outro, spinners, clean cancel lines); a script/CI/piped
  // run (or `daemon`, which is never a human at a keyboard) gets the exact
  // same plain output as before this existed, and never blocks on a prompt.
  const interactiveUi = command !== 'daemon' && Boolean(stdin.isTTY && stdout.isTTY);

  if (command === '--version' || command === 'version') {
    console.log(pc.bold('beeline 0.0.0'));
    const layout = beelineInstallLayout(process.env);
    if (layout) {
      const identity = await readInstalledBundleIdentity(layout);
      const active = await activeReleaseId(layout);
      console.log(
        `${pc.dim('installed bundle:')} ${describeIdentity(identity)}${active ? ` (release ${active})` : ''}`,
      );
    }
    return;
  }

  if (command === 'daemon') {
    installUnhandledRejectionGuard();
    const configFlag = args.indexOf('--config');
    const agentFlag = args.indexOf('--agent');
    const configPath = configFlag >= 0 ? args[configFlag + 1] : undefined;
    const agentPubkey = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
    if (agentPubkey && !configPath) {
      if (!/^[0-9a-f]{64}$/i.test(agentPubkey))
        throw new DaemonExitError(`unknown agent ${agentPubkey}`, 'failed');
      await migrateLegacyAgentUnit(agentPubkey.toLowerCase());
    }
    if (!configPath && !args.includes('--machine'))
      throw new Error('daemon requires --machine, or --config <runtime.json> for one agent');
    // `--machine` hosts every paired agent; `--config` hosts exactly one, for
    // a development checkout or a test that runs one helper by hand.
    if (configPath && process.env.BEELINE_LAB !== '1') throw new Error('daemon --config requires explicit BEELINE_LAB=1 and an isolated state root');
    const { reason, lifecycle } = await runMachineHelper(
      configPath ? { configPaths: [resolve(configPath)] } : {},
    );
    daemonLifecycle = lifecycle;
    lifecycle.exit(reason);
    return;
  }

  if (command === 'update') {
    await runUpdateCommand(args);
    return;
  }

  if (command === 'cleanup-shared-home') {
    if (args.slice(1).some((arg) => arg !== '--apply'))
      throw new Error('cleanup-shared-home accepts only --apply');
    console.log(await runCleanupSharedHomeCommand(process.env, args.includes('--apply')));
    return;
  }

  if (command === 'start') {
    await runStartCommand(args, interactiveUi);
    return;
  }

  if (command === 'stop') {
    const agentFlag = args.indexOf('--agent');
    const agentPubkey = agentFlag >= 0 ? args[agentFlag + 1] : args[1];
    if (!agentPubkey) throw new Error('stop requires --agent <pubkey>');
    const configs = await findAgentRuntimeConfigPaths(process.env, process.cwd());
    const configPath = configs.find((candidate) => dirname(candidate).endsWith(agentPubkey));
    if (!configPath) throw new Error(`no stored runtime found for agent ${agentPubkey}`);
    const runtime = await readRuntimeRecord(configPath);
    // The machine helper stops hosting this agent on its rescan and drains
    // it; every other agent on the machine keeps serving.
    await setAgentStopped(configPath, true);
    const reloaded = await reloadMachineHelper();
    if (reloaded) await requestMachine(defaultSupervisorRoot(), { operation: 'stop', agentId: runtime.agent.publicKey },
      (status) => !status.agents[runtime.agent.publicKey] || status.agents[runtime.agent.publicKey]!.state === 'stopped', 90_000);
    console.log(
      `[beeline] agent ${runtime.agent.publicKey} stopped${reloaded ? '; graceful stop requested' : ''}`,
    );
    return;
  }

  usage();
}

main().catch(async (err) => {
  const reason: HelperExitReason = err instanceof DaemonExitError ? err.reason : 'failed';
  // `daemon` is never a human at a keyboard — always the plain, full-detail
  // form (stack included) regardless of whether a TTY happens to be attached.
  const interactiveUi = process.argv[2] !== 'daemon' && Boolean(stdin.isTTY && stdout.isTTY);
  if (interactiveUi) {
    clack.cancel(err instanceof Error ? err.message : String(err));
  } else if (
    err instanceof Error &&
    err.name === 'ConnectFailureError' &&
    (process.argv[2] === 'connect' || process.argv[2] === 'connect-finish')
  ) {
    // A human is on the other end of the connect wizard even though this
    // child has no TTY (the parent spawns it with pipes). One plain sentence,
    // never a stack — the wizard surfaces this line verbatim.
    console.error(pc.red(err.message));
  } else {
    console.error(pc.red('[body] fatal:'), err);
  }
  if (process.argv[2] !== 'daemon') process.exit(1);
  if (daemonLifecycle) daemonLifecycle.exit(reason);
  else process.exit(HELPER_EXIT_CODES[reason]);
});
