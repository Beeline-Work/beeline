/** Pair command parsing, validation, onboarding, and presentation. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  createBuzzClient,
  decodeNpub,
  DEFAULT_AGENT_IDENTITY_NAME,
  DEFAULT_BODY_IDENTITY_NAME,
} from '@beeline/buzz-client';
import {
  assertAgentNotPushAllowed,
  createRelayClient,
  newIdentity,
  type Identity,
} from '@beeline/gate';
import {
  DEFAULT_ACCESS_POLICY,
  isAgentAccessPolicy,
  type AgentAccessPolicy,
} from './access-policy.js';
import { formatAgentCommand, type AgentCommand, type AgentKind } from './agent-command.js';
import { pickModelAndEffort, resolveAccessSettings } from './agent-settings-prompts.js';
import { isSharedSkillName, validateSharedSkills } from './agent-home.js';
import { withSpinner } from './clack-support.js';
import { BASE_URL, loadBodyConfig } from './config.js';
import {
  isExternalMcpCapability,
  type ExternalMcpCapability,
} from './external-mcp-capabilities.js';
import { validateAgentModelSelection } from './model-catalog.js';
import { selectPairAgentCommand } from './pair-agent-selection.js';
import {
  assertAgentIdentityUnpaired,
  defaultSupervisorRoot,
  identityFromKey,
  launchRuntimeDaemon,
  mintAgentIdentityForPairing,
  pairRepositoryAgent,
  readRuntimeRecord,
  tryInspectLocalRepository,
  type LocalRepositoryBinding,
  type PairRuntimeResult,
} from './runtime.js';
import { stableBeelineEntrypoint } from './start-command.js';
import { installAgentService } from './systemd.js';
import { connectTrustySquireForPair } from './trusty-squire-onboarding.js';
import { trustySquireConfigRoot } from './trusty-squire-storage.js';

const PAIRING_CODE_SHAPE = /^BUZZ-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
const INSTALL_AND_PAIR_COMMAND =
  'curl -fsSL https://usebeeline.app/install | sh && beeline pair BUZZ-XXXX-XXXX';

/**
 * Reject incomplete pairing invocations before even the terminal framing is
 * shown. Selecting an agent can load its live catalog and prompt for access,
 * so a missing or malformed code must never reach that work.
 */
function pairingCodeUsage(): never {
  console.error(`
${pc.bold('A pairing code matching BUZZ-XXXX-XXXX is required.')}

${pc.dim('Usage:')}
  beeline pair <BUZZ-XXXX-XXXX> [options]

${pc.dim('Install and pair:')}
  ${INSTALL_AND_PAIR_COMMAND}
`);
  process.exit(1);
}

interface PairOptions {
  codes: string[];
  kinds?: AgentKind[];
  singleKind?: AgentKind;
  customCommand?: string;
  repo?: string;
  /** Undefined means `--access` was omitted — the interactive flow (or the default) decides. */
  access?: AgentAccessPolicy;
  accessAllowlist?: string[];
  autoResponse?: string;
  model?: string;
  effort?: string;
  externalMcpCapabilities?: ExternalMcpCapability[];
  sharedSkills?: string[];
  /** The rare deliberate opt-in to reuse the ambient agent key instead of minting a fresh one. */
  useEnvKey?: boolean;
}

function parsePairOptions(args: string[]): PairOptions {
  // args[0] === 'pair'; positionals after it are pairing codes.
  const codes: string[] = [];
  let kinds: AgentKind[] | undefined;
  let singleKind: AgentKind | undefined;
  let customCommand: string | undefined;
  let repo: string | undefined;
  let access: AgentAccessPolicy | undefined;
  let accessAllowlist: string[] | undefined;
  let autoResponse: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let externalMcpCapabilities: ExternalMcpCapability[] | undefined;
  let sharedSkills: string[] | undefined;
  let useEnvKey = false;
  const flags = new Set([
    '--agent',
    '--agents',
    '--agent-command',
    '--repo',
    '--access',
    '--allow',
    '--auto-response',
    '--model',
    '--effort',
    '--mcp',
    '--share-skill',
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (!token.startsWith('--')) {
      codes.push(token);
      continue;
    }
    if (token === '--use-env-key') {
      useEnvKey = true;
      continue;
    }
    if (!flags.has(token)) throw new Error(`unknown beeline pair option: ${token}`);
    const value = args[index + 1];
    if (!value) throw new Error(`${token} requires a value`);
    index += 1;
    if (token === '--agent') singleKind = value as AgentKind;
    else if (token === '--agents')
      kinds = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean) as AgentKind[];
    else if (token === '--agent-command') customCommand = value;
    else if (token === '--repo') repo = value;
    else if (token === '--auto-response') autoResponse = value;
    else if (token === '--model') model = value;
    else if (token === '--effort') effort = value;
    else if (token === '--mcp') {
      const capabilities = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const invalid = capabilities.find((capability) => !isExternalMcpCapability(capability));
      if (invalid) {
        throw new Error(
          `--mcp must contain only squire-credential-use or squire-app-access (got: ${invalid})`,
        );
      }
      externalMcpCapabilities = capabilities as ExternalMcpCapability[];
    } else if (token === '--share-skill') {
      const names = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const invalid = names.find((name) => !isSharedSkillName(name));
      if (invalid) throw new Error(`--share-skill contains an invalid skill name: ${invalid}`);
      sharedSkills = [...new Set([...(sharedSkills ?? []), ...names])];
    } else if (token === '--access') {
      if (!isAgentAccessPolicy(value)) {
        throw new Error(`--access must be one of everyone|creator|allowlist (got: ${value})`);
      }
      access = value;
    } else if (token === '--allow') {
      const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          if (/^[0-9a-fA-F]{64}$/.test(entry)) return entry.toLowerCase();
          if (entry.startsWith('npub1')) {
            try {
              return decodeNpub(entry);
            } catch {
              // Fall through to the single stable CLI error below.
            }
          }
          throw new Error(
            `--allow must contain only npub or 64-character hex keys (got: ${entry})`,
          );
        });
      accessAllowlist = [...new Set(entries)];
    }
  }
  if (kinds && (singleKind || customCommand)) {
    throw new Error('--agents cannot be combined with --agent or --agent-command');
  }
  if (kinds && useEnvKey) {
    throw new Error('--agents cannot be combined with --use-env-key');
  }
  if (access === 'allowlist' && !accessAllowlist?.length) {
    throw new Error('--access allowlist requires --allow <npub-or-hex,...>');
  }
  if (access !== 'allowlist' && accessAllowlist !== undefined) {
    throw new Error('--allow requires --access allowlist');
  }
  return {
    codes,
    ...(kinds ? { kinds } : {}),
    ...(singleKind !== undefined ? { singleKind } : {}),
    ...(customCommand !== undefined ? { customCommand } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(access !== undefined ? { access } : {}),
    ...(accessAllowlist !== undefined ? { accessAllowlist } : {}),
    ...(autoResponse !== undefined ? { autoResponse } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(externalMcpCapabilities?.length ? { externalMcpCapabilities } : {}),
    ...(sharedSkills?.length ? { sharedSkills } : {}),
    ...(useEnvKey ? { useEnvKey } : {}),
  };
}

/**
 * Resolve the OPTIONAL repository binding `beeline pair` records at pair
 * time. Only an explicit `--repo` creates a binding; cwd is process context,
 * never repository intent.
 *
 * `--repo` is an explicit statement of intent, so a path that doesn't exist
 * or isn't a git repository is fatal. A bare `beeline pair <code>` from a
 * non-repo directory is NOT — since room-owns-repo the repository is a
 * property of the Room, and an agent with no local repository serves
 * chat-only Rooms and materializes a Room's repository when one is bound.
 *
 * Both failures are raised here, up front, before any interactive question.
 */
function resolvePairRepository(repoFlag: string | undefined): {
  cwd: string;
  repo: LocalRepositoryBinding | null;
} {
  if (!repoFlag) {
    return { cwd: process.cwd(), repo: null };
  }
  const resolved = resolve(repoFlag);
  if (!existsSync(resolved)) {
    throw new Error(`--repo path does not exist: ${resolved}`);
  }
  const repo = tryInspectLocalRepository(resolved);
  if (!repo) {
    throw new Error(`--repo path is not a git repository: ${resolved}`);
  }
  return { cwd: resolved, repo };
}

/**
 * Check model/effort against the agent's live catalog and exercise the ACP
 * setter before anything is persisted. Unknown values, missing axes, catalog
 * outages, and provider retirement refusals all fail closed here.
 */
async function validateModelSelection(
  agent: AgentCommand,
  agentEnv: Record<string, string>,
  selection: { model?: string; effort?: string },
): Promise<void> {
  if (!selection.model && !selection.effort) return;
  await validateAgentModelSelection(agent, agentEnv, selection);
}

/**
 * Pair one agent (fresh or pinned identity) and launch its durable daemon.
 *
 * This function owns the whole interactive-then-working sequence for one
 * agent, and the ordering is load-bearing: every clack prompt runs FIRST and
 * the live spinner starts only once the last question is answered. A spinner
 * started by the caller around this call would render on the same stdout line
 * as `pickModelAndEffort`'s own catalog spinner (each clack spinner drives its
 * own ~80ms `setInterval` that erases and rewrites that line), which is
 * exactly the rapid flicker between "Pairing…" and "Reading … models…" — and
 * it would keep spinning underneath the model/access prompts too.
 */
async function pairOneAgent(input: {
  code: string;
  selectedAgent: AgentCommand;
  agentIdentity: Identity;
  bodyIdentity: Identity;
  cwd: string;
  /** Resolved by `resolvePairRepository`; `null` pairs with no repository. */
  repo: LocalRepositoryBinding | null;
  /** Spinner copy for the non-interactive work phase (interactive runs only). */
  progressLabel: string;
  progressDone: (pid: number) => string;
  llmEnvFile?: string;
  /** Undefined defers to the interactive picker (or `DEFAULT_ACCESS_POLICY` non-interactively). */
  access?: AgentAccessPolicy;
  accessAllowlist?: string[];
  autoResponse?: string;
  modelSelection?: { model?: string; effort?: string };
  externalMcpCapabilities?: ExternalMcpCapability[];
  sharedSkills?: string[];
  /** Offer the clack model/effort/access/auto-response pickers when their flags weren't given. */
  interactiveUi?: boolean;
}): Promise<PairRuntimeResult> {
  const { code, selectedAgent, agentIdentity, bodyIdentity } = input;
  const mergeWorkerIdentity = newIdentity('beeline-merge-worker');
  const relayBaseUrl = (process.env.BUZZY_RELAY_URL ?? BASE_URL)
    .replace(/^ws/, 'http')
    .replace(/\/$/, '');
  const client = createBuzzClient({
    baseUrl: relayBaseUrl,
    ...(process.env.BUZZY_RELAY_HOST ? { host: process.env.BUZZY_RELAY_HOST } : {}),
    identity: agentIdentity,
  });
  // Fail before consuming the one-shot code if the local agent runtime is absent.
  const localConfig = loadBodyConfig({
    workspaceRoot: process.cwd(),
    ...(input.llmEnvFile ? { llmEnvFile: input.llmEnvFile } : {}),
    agent: selectedAgent,
  });
  const flagSelection = input.modelSelection;
  let modelSelection = flagSelection;
  // Each flag skips only its own prompt. `--model` alone must still offer the
  // effort picker (and the reverse); both flags skip the pickers entirely.
  const bothFlags = Boolean(flagSelection?.model && flagSelection?.effort);
  if (input.interactiveUi && !bothFlags) {
    const picked = await pickModelAndEffort(
      selectedAgent,
      localConfig.agentEnv,
      flagSelection ?? {},
    );
    if (picked.model || picked.effort) modelSelection = picked;
  }
  if (modelSelection?.model || modelSelection?.effort) {
    await withSpinner(
      Boolean(input.interactiveUi),
      `Validating ${selectedAgent.kind}'s live model selection…`,
      'Model/effort selection validated.',
      () => validateModelSelection(selectedAgent, localConfig.agentEnv, modelSelection ?? {}),
    );
  }
  const { access, autoResponse } = await resolveAccessSettings({
    ...(input.access !== undefined ? { access: input.access } : {}),
    ...(input.autoResponse !== undefined ? { autoResponse: input.autoResponse } : {}),
    interactiveUi: Boolean(input.interactiveUi),
  });
  if (input.externalMcpCapabilities?.length && access !== 'creator') {
    throw new Error('external MCP capabilities require --access creator');
  }
  if (
    input.externalMcpCapabilities?.length &&
    /^BUZZ-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/i.test(code.trim())
  ) {
    console.log("[beeline] checking this machine's Trusty Squire vault/link…");
    const configRoot = trustySquireConfigRoot(defaultSupervisorRoot(process.env));
    const connected = await connectTrustySquireForPair({
      agentKind: selectedAgent.kind,
      configRoot,
    });
    console.log(
      `[beeline] Trusty Squire connected locally; skill loaded at ${connected.skillPath}`,
    );
  }
  await validateSharedSkills(homedir(), [
    ...(input.sharedSkills ?? []),
    ...(input.externalMcpCapabilities?.length ? ['trusty-squire'] : []),
  ]);
  // Every question is answered — only now is one spinner alone on the line.
  const spinner = input.interactiveUi ? clack.spinner() : undefined;
  spinner?.start(input.progressLabel);
  try {
    const result = await pairRepositoryAgent(
      {
        code,
        cwd: input.cwd,
        repo: input.repo,
        relayBaseUrl,
        ...(process.env.BUZZY_RELAY_HOST ? { relayHost: process.env.BUZZY_RELAY_HOST } : {}),
        ...(input.llmEnvFile ? { llmEnvFile: input.llmEnvFile } : {}),
        agentIdentity,
        bodyIdentity,
        mergeWorkerIdentity,
        agentBinary: localConfig.agentBinary,
        agentKind: selectedAgent.kind,
        agentCommand: selectedAgent.command,
        agentArgs: selectedAgent.args,
        accessPolicy: access,
        ...(input.accessAllowlist ? { accessAllowlist: input.accessAllowlist } : {}),
        ...(autoResponse ? { accessAutoResponse: autoResponse } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(input.externalMcpCapabilities?.length
          ? { externalMcpCapabilities: input.externalMcpCapabilities }
          : {}),
        ...(input.sharedSkills?.length ? { sharedSkills: input.sharedSkills } : {}),
        mcpBinary: localConfig.mcpBinary,
      },
      {
        redeem: (pairingCode) => client.redeemAgentPairingCode(pairingCode),
        resolveRoom: (pairing, repository, mergeWorkerPubkey) =>
          client.resolveRepositoryRoom(
            pairing.communityId,
            repository,
            pairing.pairedBy,
            mergeWorkerPubkey,
          ),
        // Undo this agent's own Workspace registration when a later pair step
        // fails, so a failed run leaves no permanently-offline ghost behind.
        abandonPairing: async (pairing) => {
          if (await client.abandonAgentPairing(pairing.communityId)) return;
          console.error(
            `[beeline] could not unregister agent ${agentIdentity.publicKey} after the failed ` +
              'pairing; remove it from the Workspace in the app to clear the offline entry.',
          );
        },
        validate: async (_pairing, _room, repo) => {
          if (!repo.relayRepo) return;
          await assertAgentNotPushAllowed({
            ownerHex: repo.relayRepo.ownerHex,
            repo: repo.relayRepo.repo,
            agentPubkey: agentIdentity.publicKey,
            protectedRef: `refs/heads/${repo.targetBranch}`,
            relay: createRelayClient(agentIdentity, {
              baseUrl: relayBaseUrl,
              host: new URL(relayBaseUrl).host,
            }),
          });
        },
        launch: async (configPath) => {
          const stored = await readRuntimeRecord(configPath);
          return process.platform === 'linux' && process.env.BEELINE_SYSTEMD_USER !== '0'
            ? installAgentService(stored.agent.publicKey, {
                entrypoint: stableBeelineEntrypoint(),
              })
            : launchRuntimeDaemon(configPath);
        },
      },
    );
    spinner?.stop(pc.green(input.progressDone(result.pid)));
    return result;
  } catch (error) {
    spinner?.stop(pc.red('Pairing failed.'));
    throw error;
  }
}

function printPairResult(result: PairRuntimeResult): void {
  console.log(`[buzz] paired agent ${pc.bold(result.pairing.agent.displayName)}`);
  console.log(`[buzz] workspace: ${result.pairing.communityId}`);
  const pairedRoom = result.runtime.rooms[0];
  if (result.room && pairedRoom) {
    console.log(
      `[buzz] room: ${result.room.channelId} (${result.room.created ? 'created' : 'joined'})`,
    );
    console.log(`[buzz] repo: ${pairedRoom.repo.root}`);
  } else {
    console.log(
      '[buzz] repo: none — add this agent to a Room from the app; each Room supplies its own',
    );
  }
  console.log(`[buzz] agent pubkey: ${result.pairing.agent.pubkey}`);
  console.log(`[buzz] access policy: ${result.runtime.accessPolicy ?? DEFAULT_ACCESS_POLICY}`);
  if (result.runtime.externalMcpCapabilities?.length) {
    console.log(`[buzz] external MCP: ${result.runtime.externalMcpCapabilities.join(', ')}`);
  }
  if (result.runtime.modelSelection) {
    console.log(
      `[buzz] model/effort default: ${pc.cyan(result.runtime.modelSelection.model ?? '(unset)')} / ${pc.cyan(
        result.runtime.modelSelection.effort ?? '(unset)',
      )}`,
    );
  }
  console.log(`[buzz] daemon started ${pc.green(`(pid ${result.pid})`)}`);
}

/**
 * Parse, validate, and execute `beeline pair`. Every failure mode here — a
 * bad flag, an unresolvable repo, an unadvertised model/effort, a
 * redemption failure — is meant for the operator to read and act on, so
 * it's caught here and reported as a plain message, not a stack trace.
 */
export async function runPairCommand(
  args: string[],
  llmEnvFile: string | undefined,
  agentPrivateKey: string | undefined,
): Promise<void> {
  // A picker on a stream that isn't a real TTY would just hang — never
  // attempted then. `--model`/`--effort` (or accepting no selection at all,
  // same as before this feature existed) remain the non-interactive path.
  const interactiveUi = Boolean(stdin.isTTY && stdout.isTTY);
  try {
    const pairOptions = parsePairOptions(args);
    if (
      pairOptions.codes.length === 0 ||
      pairOptions.codes.some((code) => !PAIRING_CODE_SHAPE.test(code.trim()))
    ) {
      pairingCodeUsage();
    }
    if (interactiveUi) clack.intro(pc.bold('beeline pair'));
    if (pairOptions.useEnvKey && !agentPrivateKey) {
      throw new Error('--use-env-key requires BUZZ_AGENT_KEY or BUZZ_PRIVATE_KEY to be set');
    }
    if (agentPrivateKey) {
      console.warn(
        pairOptions.useEnvKey
          ? '[beeline] pair is reusing the ambient BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY as this agent identity (--use-env-key)'
          : '[beeline] pair ignores BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY and is minting a fresh agent identity',
      );
    }
    const { cwd: pairCwd, repo: pairRepo } = resolvePairRepository(pairOptions.repo);
    const flagModelSelection: { model?: string; effort?: string } | undefined =
      pairOptions.model || pairOptions.effort
        ? {
            ...(pairOptions.model ? { model: pairOptions.model } : {}),
            ...(pairOptions.effort ? { effort: pairOptions.effort } : {}),
          }
        : undefined;

    if (pairOptions.kinds) {
      // Multi-runtime: one single-use pairing code per agent, each minting its
      // own fresh keypair and launching its own daemon. Three distinct agents
      // in one Workspace/Room, each independently @-mentionable. --model/
      // --effort flags (if given) apply identically to every agent, same
      // convention as --access/--auto-response; the interactive picker below
      // instead runs once per agent against that agent's own live catalog,
      // which is the more correct behaviour across differing harnesses.
      const { codes, kinds } = pairOptions;
      if (codes.length !== kinds.length) {
        throw new Error(
          `--agents expects one pairing code per agent: got ${codes.length} code(s) for ${kinds.length} agent(s)`,
        );
      }
      for (let index = 0; index < codes.length; index += 1) {
        const kind = kinds[index]!;
        const selectedAgent = await selectPairAgentCommand({
          explicitKind: kind,
          env: process.env,
          cwd: process.cwd(),
        });
        console.log(
          `[body] agent ${index + 1}/${codes.length} (${kind}) binary: ${formatAgentCommand(selectedAgent)}`,
        );
        const result = await pairOneAgent({
          code: codes[index]!,
          selectedAgent,
          agentIdentity: mintAgentIdentityForPairing(),
          bodyIdentity: newIdentity(DEFAULT_BODY_IDENTITY_NAME),
          cwd: pairCwd,
          repo: pairRepo,
          progressLabel: `Pairing agent ${index + 1}/${codes.length} (${kind})…`,
          progressDone: (pid) => `Paired ${kind} (pid ${pid}).`,
          ...(llmEnvFile ? { llmEnvFile } : {}),
          access: pairOptions.access,
          accessAllowlist: pairOptions.accessAllowlist,
          ...(pairOptions.autoResponse ? { autoResponse: pairOptions.autoResponse } : {}),
          ...(flagModelSelection ? { modelSelection: flagModelSelection } : {}),
          interactiveUi,
          externalMcpCapabilities: pairOptions.externalMcpCapabilities,
          sharedSkills: pairOptions.sharedSkills,
        });
        printPairResult(result);
      }
      if (interactiveUi) clack.outro(pc.green('All agents paired.'));
      return;
    }

    if (pairOptions.codes.length > 1) {
      throw new Error('multiple pairing codes require --agents <kind1,kind2,...>');
    }
    // Pairing always creates one new identity by default. In particular, the
    // legacy BUZZ_PRIVATE_KEY used by human clients is never an ambient
    // agent-key fallback — reusing it requires the explicit --use-env-key opt-in.
    const agentIdentity = pairOptions.useEnvKey
      ? identityFromKey(agentPrivateKey, DEFAULT_AGENT_IDENTITY_NAME)
      : mintAgentIdentityForPairing();
    await assertAgentIdentityUnpaired(defaultSupervisorRoot(process.env), agentIdentity.publicKey);
    const selectedAgent = await selectPairAgentCommand({
      explicitKind: pairOptions.singleKind,
      customCommand: pairOptions.customCommand,
      env: process.env,
      cwd: process.cwd(),
    });
    console.log(`[body] agent binary: ${formatAgentCommand(selectedAgent)}`);
    const result = await pairOneAgent({
      code: pairOptions.codes[0]!,
      selectedAgent,
      agentIdentity,
      bodyIdentity: identityFromKey(process.env.BUZZ_BODY_KEY, DEFAULT_BODY_IDENTITY_NAME),
      cwd: pairCwd,
      repo: pairRepo,
      progressLabel: 'Pairing…',
      progressDone: (pid) => `Paired (pid ${pid}).`,
      ...(llmEnvFile ? { llmEnvFile } : {}),
      access: pairOptions.access,
      accessAllowlist: pairOptions.accessAllowlist,
      ...(pairOptions.autoResponse ? { autoResponse: pairOptions.autoResponse } : {}),
      ...(flagModelSelection ? { modelSelection: flagModelSelection } : {}),
      interactiveUi,
      externalMcpCapabilities: pairOptions.externalMcpCapabilities,
      sharedSkills: pairOptions.sharedSkills,
    });
    printPairResult(result);
    if (interactiveUi) clack.outro(pc.green('Done.'));
  } catch (error) {
    if (interactiveUi) clack.cancel(error instanceof Error ? error.message : String(error));
    else console.error(`[beeline] pair failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
