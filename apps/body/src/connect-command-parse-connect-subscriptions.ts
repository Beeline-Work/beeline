import { resolve, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { readFile, mkdir, writeFile, chmod, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { normalizeAgentPairingCode } from "@beeline/api-contract/phone";
import { agentBehavior } from "./agent-command.js";
import { defaultSupervisorRoot, findAgentRuntimeConfigPaths } from "./runtime.js";
import { spawn } from "node:child_process";
import * as clack from "@clack/prompts";
import { clackPromptOutput } from "./clack-support.js";
import { type AgentAccessPolicy, isAgentAccessPolicy } from "./access-policy.js";
import { verifyProviderKey } from "./provider-key-check.js";
import { agentComputeWarning } from "./agent-compute-warning.js";
import { type DevicePairingGrant, completeDevicePairing } from "./device-pairing.js";
import { isCanonicalInstalledLauncher } from "./systemd.js";
import { openRouterModelId, resolveOpenRouterRouting, openRouterRoutingCacheDir } from "./openrouter-routing.js";
import { ConnectWizardResult, DeviceGrantResponse, jsonRequest, ConnectProvider, brass, clackPrompts, collectConnectWizard, loadConnectModelCatalog, fileConnectKeyStore, installCurrentRelease, ConnectPrompts, isReasonableAgentName, AGENT_NAME_MAX_LENGTH, CONNECT_HARNESSES } from './connect-command.js';





/**
 * The kinds `--subscribe` accepts. Parsed here only to keep an obvious typo out
 * of the request; the monolith owns the registry and drops anything else.
 */
export function parseConnectSubscriptions(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}



/**
 * Resolve a stable MACHINE identifier for this host. Uses a persisted UUID in
 * `~/.config/beeline/machine-id` (created once), so every agent connected from
 * the same machine shares one machine_id — even across reconnects and OS
 * reinstalls that reuse the home directory. Falls back to a hash of the
 * hostname only when no persisted id exists AND the config dir is unwritable.
 */
export async function readMachineId(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ machineId: string; machineName: string }> {
  const configDir = resolve(env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'beeline');
  const machineIdPath = resolve(configDir, 'machine-id');
  let machineId: string;
  let machineName = hostname();
  try {
    const existing = await readFile(machineIdPath, 'utf8');
    machineId = existing.trim();
    if (!/^[0-9a-f-]{32,}$/.test(machineId)) throw new Error('invalid persisted machine id');
  } catch {
    machineId = randomUUID();
    try {
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeFile(machineIdPath, `${machineId}\n`, { mode: 0o600 });
    } catch {
      // Home directory is unwritable; fall back to a hash of the hostname so
      // every agent on this host at least shares one id for the session.
      machineId = createHash('sha256').update(machineName).digest('hex').slice(0, 36);
    }
  }
  return { machineId, machineName };
}



export function requestConnectGrant(
  baseUrl: string,
  pairingCode: string,
  selection: ConnectWizardResult,
  fetchImpl: typeof fetch,
  machineInfo?: { machineId: string; machineName: string },
): Promise<DeviceGrantResponse> {
  const normalizedPairingCode = normalizeAgentPairingCode(pairingCode);
  if (!normalizedPairingCode) throw new Error('invalid pairing code');
  // The wizard cannot know the agent pubkey before the server mints the
  // keypair, so it derives a deterministic avatar seed from the one-time
  // pairing code; absent a seed, the server defaults to the pubkey.
  const avatarSeed = createHash('sha256')
    .update(normalizedPairingCode.toUpperCase())
    .digest('hex')
    .slice(0, 32);
  return jsonRequest<DeviceGrantResponse>(
    `${baseUrl}/auth/agent/connect`,
    {
      pairing_code: normalizedPairingCode,
      harness: selection.harness,
      ...(selection.provider ? { provider: selection.provider } : {}),
      model: selection.model,
      ...(selection.effort ? { effort: selection.effort } : {}),
      avatar_seed: avatarSeed,
      // This wizard always finishes the join itself (`finishConnectedAgentPairing`,
      // called once the rename prompt below settles), so the claim must not
      // join Rooms or announce yet.
      defer_join: true,
      ...(machineInfo
        ? { machine_id: machineInfo.machineId, machine_name: machineInfo.machineName }
        : {}),
    },
    fetchImpl,
  );
}



/**
 * The one rename the terminal may make, right after the seeded identity is
 * printed. The pairing code is the authority and the server closes the window
 * shortly after the claim; every later rename lives in the app.
 */
export async function renameConnectedAgent(
  baseUrl: string,
  pairingCode: string,
  name: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const normalizedPairingCode = normalizeAgentPairingCode(pairingCode);
  if (!normalizedPairingCode) throw new Error('invalid pairing code');
  const renamed = await jsonRequest<{ agent_name: string }>(
    `${baseUrl}/auth/agent/connect/name`,
    { pairing_code: normalizedPairingCode, agent_name: name.trim().replace(/\s+/g, ' ') },
    fetchImpl,
  );
  return renamed.agent_name;
}



/**
 * The wizard's last step: joins the agent to the Workspace's live top-level
 * Rooms and writes the "joined" announcement. Called once the rename decision
 * above is settled (kept or renamed), so the announcement carries whichever
 * name the person ends up with — never the seeded placeholder it started as.
 */
export async function finishConnectedAgentPairing(
  baseUrl: string,
  pairingCode: string,
  workspaceJoined: boolean,
  eventSubscriptions: readonly string[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const normalizedPairingCode = normalizeAgentPairingCode(pairingCode);
  if (!normalizedPairingCode) throw new Error('invalid pairing code');
  await jsonRequest<{ ok: true }>(
    `${baseUrl}/auth/agent/connect/finish`,
    {
      pairing_code: normalizedPairingCode,
      workspace_joined: workspaceJoined,
      ...(eventSubscriptions.length ? { event_subscriptions: [...eventSubscriptions] } : {}),
    },
    fetchImpl,
  );
}



/** `Foxy the fox` — one line naming what to look for in the app. */
export function seededIdentityLine(grant: { agent_name: string; agent_face?: string }): string {
  return grant.agent_face ? `${grant.agent_name} the ${grant.agent_face}` : grant.agent_name;
}



export function providerEnvironment(
  selection: Pick<ConnectWizardResult, 'harness' | 'provider' | 'apiKey' | 'model'>,
): Record<string, string> {
  if (!selection.provider || !selection.apiKey) return {};
  const keyNames: Record<ConnectProvider, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    xai: 'XAI_API_KEY',
  };
  return {
    [keyNames[selection.provider]]: selection.apiKey,
    ...(agentBehavior(selection.harness).providerModelEnv
      ? {
          [agentBehavior(selection.harness).providerModelEnv!.provider]: selection.provider,
          [agentBehavior(selection.harness).providerModelEnv!.model]: selection.model,
        }
      : {}),
  };
}



export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}



export async function writeProviderEnv(
  selection: ConnectWizardResult,
  agentPubkey: string,
): Promise<string | undefined> {
  const values = providerEnvironment(selection);
  if (Object.keys(values).length === 0) return undefined;
  const path = resolve(
    defaultSupervisorRoot(process.env),
    'beeline',
    'connect',
    `${agentPubkey}.env`,
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const contents = Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
  await writeFile(path, `${contents}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}



export async function runInstalledFinish(binary: string, grantPath: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(binary, ['connect-finish', grantPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostic = '';
    const retainDiagnostic = (chunk: Buffer): void => {
      diagnostic = `${diagnostic}${chunk.toString('utf8')}`.slice(-16_000);
    };
    child.stdout?.on('data', retainDiagnostic);
    child.stderr?.on('data', retainDiagnostic);
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else {
        const outcome = signal
          ? `installed Beeline exited on ${signal}`
          : `installed Beeline exited ${code}`;
        rejectRun(new Error(`${outcome}${diagnostic.trim() ? `: ${diagnostic.trim()}` : ''}`));
      }
    });
  });
}



export async function brassSpinner<T>(
  message: string,
  action: () => Promise<T>,
  completion: (result: T) => string,
): Promise<T> {
  const spinner = clack.spinner({ output: clackPromptOutput() });
  spinner.start(brass(message));
  try {
    const result = await action();
    spinner.stop(brass(completion(result)));
    return result;
  } catch (error) {
    spinner.stop('Failed');
    throw error;
  }
}



export async function runConnectWizard(
  code: string | undefined,
  fetchImpl: typeof fetch,
  eventSubscriptions: readonly string[],
  accessPolicy: AgentAccessPolicy | undefined,
): Promise<void> {
  clack.intro(brass('Beeline connect'));
  const pairingCode =
    code?.trim() ||
    (await clackPrompts.text({
      message: brass('Pairing code from the app'),
      validate: (value) =>
        normalizeAgentPairingCode(value) ? undefined : 'Enter the pairing code shown in the app',
    }));
  const selection = await collectConnectWizard(
    clackPrompts,
    loadConnectModelCatalog,
    fileConnectKeyStore,
    process.env,
    (input) => verifyProviderKey({ ...input, fetchImpl }),
  );
  const baseUrl = (process.env.BEELINE_AUTH_URL ?? 'https://server.usebeeline.app').replace(
    /\/$/,
    '',
  );
  const machineInfo = await readMachineId(process.env);
  const claimed = await brassSpinner(
    'Connecting to your Beeline Workspace…',
    () => requestConnectGrant(baseUrl, pairingCode, selection, fetchImpl, machineInfo),
    (connectedGrant) => `Connected to ${connectedGrant.workspace_name}`,
  );
  // The server seeded this agent's animal, name and soul from its Workspace
  // roster. Show what to look for in the app, and offer the one rename the
  // terminal gets before the helper starts under that name.
  const grant = {
    ...claimed,
    agent_name: await confirmSeededName(baseUrl, pairingCode, claimed, fetchImpl),
  };
  // Only now is the agent's final name on record: join it into the Workspace's
  // Rooms and let the "joined" line land under that name, not the seeded one.
  await finishConnectedAgentPairing(
    baseUrl,
    pairingCode,
    grant.workspace_joined,
    eventSubscriptions,
    fetchImpl,
  );
  const agentCount = (await findAgentRuntimeConfigPaths()).length + 1;
  const computeWarning = agentComputeWarning(agentCount);
  if (computeWarning) clack.log.warn(brass(computeWarning));
  const installedRelease = await brassSpinner(
    'Installing the Beeline daemon…',
    () => installCurrentRelease(fetchImpl),
    (release) => `Installed Beeline helper ${release.version}`,
  );
  const llmEnvFile = await writeProviderEnv(selection, grant.agent_pubkey);
  const grantPath = resolve(
    defaultSupervisorRoot(process.env),
    'beeline',
    'connect',
    `grant-${process.pid}-${Date.now()}.json`,
  );
  await writePrivateJson(grantPath, {
    agentSecretKey: grant.agent_secret_key,
    bodySecretKey: grant.body_secret_key,
    agentName: grant.agent_name,
    harness: grant.harness,
    model: grant.model,
    // The server echoes back what it stored; the wizard's own answer is the
    // fallback for a server too old to carry the effort through.
    ...((grant.effort ?? selection.effort) ? { effort: grant.effort ?? selection.effort } : {}),
    soul: grant.soul,
    workspaceId: grant.workspace_id,
    workspaceName: grant.workspace_name,
    pairedBy: grant.paired_by,
    monolithBaseUrl: baseUrl,
    daemonExchangeToken: grant.daemon_exchange_token,
    ...(llmEnvFile ? { llmEnvFile } : {}),
    ...(accessPolicy ? { accessPolicy } : {}),
  } satisfies DevicePairingGrant);
  await brassSpinner(
    'Starting your agent…',
    () => runInstalledFinish(installedRelease.binary, grantPath),
    () => `Started ${grant.agent_name}`,
  );
  console.log('');
  console.log(`${brass('Agent')}      ${seededIdentityLine(grant)}`);
  console.log(`${brass('Workspace')}  ${grant.workspace_name}`);
  clack.outro(brass('Say hi in the app.'));
}



/**
 * Print the seeded identity, then two keys: keep it, or rename it here. The
 * rename lands before the helper is staged, so the runtime is written under
 * the name the person chose.
 */
export async function confirmSeededName(
  baseUrl: string,
  pairingCode: string,
  grant: { agent_name: string; agent_face?: string },
  fetchImpl: typeof fetch,
  prompts: Pick<ConnectPrompts, 'select' | 'text'> = clackPrompts,
): Promise<string> {
  clack.log.info(brass(`Your agent is ${seededIdentityLine(grant)}.`));
  const choice = await prompts.select<'keep' | 'rename'>({
    message: brass('Name'),
    initialValue: 'keep',
    options: [
      { value: 'keep', label: `Keep ${grant.agent_name}`, hint: 'default' },
      { value: 'rename', label: 'Rename this agent' },
    ],
  });
  if (choice === 'keep') return grant.agent_name;
  const renamed = await prompts.text({
    message: brass('Agent name'),
    initialValue: grant.agent_name,
    validate: (value) => {
      if (!value.trim()) return 'Agent name is required';
      return isReasonableAgentName(value)
        ? undefined
        : `Use letters, spaces, hyphens, or apostrophes (${AGENT_NAME_MAX_LENGTH} characters max)`;
    },
  });
  try {
    return await renameConnectedAgent(baseUrl, pairingCode, renamed, fetchImpl);
  } catch (error) {
    // The agent is already claimed and about to start. A failed rename is not
    // worth losing the connection over: keep the seeded name and say so, so
    // the person renames it in the app instead.
    clack.log.warn(
      brass(
        `Could not rename this agent (${error instanceof Error ? error.message : String(error)}); it stays ${grant.agent_name}. Rename it in the app.`,
      ),
    );
    return grant.agent_name;
  }
}



export function isDevicePairingGrant(value: unknown): value is DevicePairingGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<DevicePairingGrant>;
  if (grant.accessPolicy !== undefined && !isAgentAccessPolicy(grant.accessPolicy)) return false;
  let monolithOrigin = '';
  try {
    monolithOrigin = new URL(grant.monolithBaseUrl ?? '').origin;
  } catch {
    return false;
  }
  return (
    typeof grant.agentSecretKey === 'string' &&
    /^[0-9a-f]{64}$/.test(grant.agentSecretKey) &&
    typeof grant.bodySecretKey === 'string' &&
    /^[0-9a-f]{64}$/.test(grant.bodySecretKey) &&
    typeof grant.agentName === 'string' &&
    CONNECT_HARNESSES.includes(grant.harness as (typeof CONNECT_HARNESSES)[number]) &&
    typeof grant.model === 'string' &&
    (grant.effort === undefined || typeof grant.effort === 'string') &&
    typeof grant.soul === 'string' &&
    typeof grant.workspaceId === 'string' &&
    typeof grant.workspaceName === 'string' &&
    typeof grant.pairedBy === 'string' &&
    /^[0-9a-f]{64}$/.test(grant.pairedBy) &&
    typeof grant.monolithBaseUrl === 'string' &&
    grant.monolithBaseUrl === monolithOrigin &&
    /^https?:$/.test(new URL(monolithOrigin).protocol) &&
    typeof grant.daemonExchangeToken === 'string' &&
    /^bde_[A-Za-z0-9_-]{43}$/.test(grant.daemonExchangeToken)
  );
}



/**
 * One plain sentence for a human at the end of a terminal — no stacks, no
 * multi-frame ACP dumps. Keeps the first line of the message and drops any
 * embedded stack or multi-line diagnostic.
 */
export function connectPlainFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return `Connecting your agent failed: ${firstLine ?? 'unknown error'}`;
}



export class ConnectFailureError extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'ConnectFailureError';
  }
}



export async function runConnectFinishCommand(path: string | undefined): Promise<void> {
  if (!path) throw new Error('connect-finish requires a grant path');
  if (!isCanonicalInstalledLauncher(process.env, process.argv[1])) {
    throw new Error('connect-finish may run only from the canonical installed Beeline launcher');
  }
  try {
    const grant = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
    if (!isDevicePairingGrant(grant)) throw new Error('device connection grant is invalid');
    const connected = await completeDevicePairing(grant);
    await unlink(resolve(path));
    // Warm the per-model OpenRouter routing cache so the daemon's first
    // activation already knows its reliable provider set. Best effort: the
    // daemon re-derives it at every activation regardless.
    const providerEnv = grant.llmEnvFile
      ? await readFile(grant.llmEnvFile, 'utf8').catch(() => '')
      : '';
    const apiKey = (/^OPENROUTER_API_KEY=(\S+)/m.exec(providerEnv)?.[1] ?? '').replace(
      /^["']|["']$/g,
      '',
    );
    const model = openRouterModelId(grant.model, { OPENROUTER_API_KEY: apiKey });
    if (model) {
      const decision = await resolveOpenRouterRouting({
        model,
        cacheDir: openRouterRoutingCacheDir(dirname(connected.configPath)),
        ...(apiKey ? { apiKey } : {}),
        probeTimeoutMs: 10_000,
      });
      console.log(decision.line);
      // Connect is the one place the answer probe MAY block: warming it here
      // is what keeps the daemon's first turn off a silent provider.
      const probed = await decision.refresh;
      if (probed) console.log(probed.line);
    }
  } catch (error) {
    // connect-finish runs without a TTY (the parent spawns it with pipes), so
    // the CLI's catch would print the full error object — stack included —
    // into a diagnostic the wizard surfaces verbatim. Throw one plain
    // sentence instead; the ConnectFailureError name tells the CLI catch to
    // print the message only.
    throw new ConnectFailureError(connectPlainFailure(error));
  }
}
