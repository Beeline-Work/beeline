import { parseOpenRouterEndpoints, piInputModalities } from './openrouter-routing.js';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { LEGACY_ACCESS_POLICY } from './access-policy.js';
import { resolveAgentCommand } from './agent-command.js';
import { loadBodyConfig, parseEnvFile } from './config.js';
import { activateDaemonTransport } from './daemon-api-client.js';
import { runMachineHelper } from './machine-helper.js';
import {
  defaultSupervisorRoot,
  identityFromKey,
  readRuntimeRecord,
  runtimeConfigPath,
  runtimeDirectory,
  stageMonolithAgentRuntime,
  writeRuntimeRecord,
} from './runtime.js';

/**
 * `beeline free-agent`: the entry point on a free starter agent's Fly Machine.
 * The first boot trades the Machine's one-time bootstrap token for its agent
 * identity, a daemon exchange token and a model token; every boot then hosts
 * that one agent with the idle sleep of `free-agent-idle.ts`. The Machine's
 * root filesystem persists, so later boots skip the bootstrap.
 */
export interface FreeAgentGrant {
  agentId: string;
  agentSecretKey: string;
  bodySecretKey: string;
  agentName: string;
  harness: 'pi' | 'opencode';
  model: string;
  soul: string;
  workspaceId: string;
  workspaceName: string;
  pairedBy: string;
  monolithBaseUrl: string;
  daemonExchangeToken: string;
  modelToken: string;
  modelBaseUrl: string;
  upstreamModel: string;
  maxTurnSeconds?: number;
  idleSeconds: number;
}

interface FreeAgentSettings {
  idleSeconds: number;
}

/** Pi's private provider uses only the scoped proxy token, resolved from env. */
export function freeAgentPiConfig(grant: Pick<FreeAgentGrant, 'modelBaseUrl' | 'upstreamModel'>, input: Array<'text' | 'image'> = ['text']): string {
  return JSON.stringify({
    providers: {
      beeline: {
        baseUrl: grant.modelBaseUrl,
        api: 'openai-completions',
        apiKey: '$BEELINE_FREE_AGENT_MODEL_TOKEN',
        models: [{
          id: grant.upstreamModel,
          name: grant.upstreamModel,
          reasoning: true,
          input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 65_536,
        }],
      },
    },
  });
}

async function freeAgentInput(model: string): Promise<Array<'text' | 'image'>> {
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return ['text'];
    return piInputModalities(parseOpenRouterEndpoints(await response.json()).inputModalities) ?? ['text'];
  } catch {
    return ['text'];
  }
}

/** Values are single lines; parseEnvFile does not unescape quoted values. */
export function freeAgentModelEnv(grant: Pick<FreeAgentGrant, 'modelToken' | 'maxTurnSeconds'>): string {
  const lines = {
    BEELINE_FREE_AGENT_MODEL_TOKEN: grant.modelToken,
    BEELINE_FREE_AGENT_MAX_TURN_SECONDS: String(grant.maxTurnSeconds ?? 900),
    BEELINE_BODY_AGENT_ENV_PASSTHROUGH: [
      'BEELINE_FREE_AGENT_MODEL_TOKEN',
      'BEELINE_FREE_AGENT_MAX_TURN_SECONDS',
    ].join(','),
  };
  return `${Object.entries(lines)
    .map(([key, value]) => `${key}=${value.replace(/[\r\n]/g, '')}`)
    .join('\n')}\n`;
}

export async function fetchFreeAgentGrant(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<FreeAgentGrant> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchImpl(new URL('/v1/free-agents/bootstrap', serverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401) throw new Error('free agent bootstrap token was refused');
      if (!response.ok) throw new Error(`free agent bootstrap failed: HTTP ${response.status}`);
      return (await response.json()) as FreeAgentGrant;
    } catch (error) {
      if (attempt >= 8 || (error instanceof Error && error.message.includes('refused'))) throw error;
      console.warn(`[free-agent] bootstrap attempt ${attempt} failed; retrying:`, error);
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

async function writePrivate(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function hasDaemonToken(configPath: string): Promise<boolean> {
  try {
    const transport = (await readRuntimeRecord(configPath)).transport;
    return Boolean(transport && 'daemonToken' in transport && transport.daemonToken);
  } catch {
    return false;
  }
}

/** Stage and activate this Machine's one agent from its bootstrap grant. */
export async function stageFreeAgent(
  env: NodeJS.ProcessEnv,
  grant: FreeAgentGrant,
): Promise<{ configPath: string }> {
  const supervisorRoot = defaultSupervisorRoot(env);
  const directory = resolve(supervisorRoot, 'beeline', 'free-agent');
  const llmEnvFile = resolve(directory, 'model.env');
  await writePrivate(llmEnvFile, freeAgentModelEnv(grant));
  await writePrivate(
    resolve(directory, 'settings.json'),
    `${JSON.stringify({ idleSeconds: grant.idleSeconds } satisfies FreeAgentSettings)}\n`,
  );
  await writePrivate(resolve(env.HOME ?? '/root', '.pi/agent/models.json'), freeAgentPiConfig(grant, await freeAgentInput(grant.upstreamModel)));
  const agent = await freeAgentPiCommand(env);
  const localConfig = loadBodyConfig({ workspaceRoot: process.cwd(), llmEnvFile, agent, env });
  const staged = await stageMonolithAgentRuntime({
    workspaceId: grant.workspaceId,
    pairedBy: grant.pairedBy,
    monolithBaseUrl: grant.monolithBaseUrl,
    daemonExchangeToken: grant.daemonExchangeToken,
    llmEnvFile,
    agentBinary: localConfig.agentBinary,
    agentKind: agent.kind,
    agentCommand: agent.command,
    agentArgs: agent.args,
    modelSelection: { model: grant.model },
    accessPolicy: LEGACY_ACCESS_POLICY,
    mcpBinary: localConfig.mcpBinary,
    agentIdentity: identityFromKey(grant.agentSecretKey, grant.agentName),
    bodyIdentity: identityFromKey(grant.bodySecretKey, 'beeline-body'),
    supervisorRoot,
  });
  if (!(await activateDaemonTransport(staged.configPath)))
    throw new Error('free agent daemon transport activation failed');
  return { configPath: staged.configPath };
}

// Agent programs come from the Machine image or its operator, never helper downloads.
async function freeAgentPiCommand(env: NodeJS.ProcessEnv) {
  return resolveAgentCommand({ kind: 'pi', env });
}

/** Reconcile persisted environment before starting sessions, including existing Pi runtimes. */
async function upgradeFreeAgentHarness(configPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const runtime = await readRuntimeRecord(configPath);
  if ((runtime.agentKind !== 'pi' && runtime.agentKind !== 'opencode') || !runtime.llmEnvFile)
    throw new Error('unsupported persisted free agent harness');
  const original = await readFile(runtime.llmEnvFile, 'utf8');
  const previous = parseEnvFile(runtime.llmEnvFile);
  const canonicalName = (name: string) => name.replace(/^BUZZY_/, 'BEELINE_');
  const normalized = { ...previous };
  for (const [name, value] of Object.entries(previous)) {
    if (!name.startsWith('BUZZY_')) continue;
    normalized[canonicalName(name)] ??= value;
    delete normalized[name];
  }
  const passthrough = new Set(
    [previous.BUZZY_BODY_AGENT_ENV_PASSTHROUGH, previous.BEELINE_BODY_AGENT_ENV_PASSTHROUGH]
      .filter(Boolean).join(',').split(',').map(name => canonicalName(name.trim())).filter(Boolean),
  );
  passthrough.add('BEELINE_FREE_AGENT_MODEL_TOKEN');
  passthrough.add('BEELINE_FREE_AGENT_MAX_TURN_SECONDS');
  normalized.BEELINE_BODY_AGENT_ENV_PASSTHROUGH = [...passthrough].join(',');
  normalized.BEELINE_FREE_AGENT_MAX_TURN_SECONDS ??= '900';
  if (!normalized.BEELINE_FREE_AGENT_MODEL_TOKEN)
    throw new Error('free agent proxy configuration is missing');
  if (runtime.agentKind === 'opencode') {
    const provider = JSON.parse(previous.OPENCODE_CONFIG_CONTENT ?? '{}').provider?.beeline;
    if (!provider?.options?.baseURL) throw new Error('free agent proxy configuration is missing');
    const model = runtime.modelSelection?.model;
    if (!model?.startsWith('beeline/')) throw new Error('free agent proxy model is missing');
    const agent = await freeAgentPiCommand(env);
    await writePrivate(resolve(env.HOME ?? '/root', '.pi/agent/models.json'), freeAgentPiConfig({
      modelBaseUrl: provider.options.baseURL,
      upstreamModel: model.slice('beeline/'.length),
    }, await freeAgentInput(model.slice('beeline/'.length))));
    runtime.agentKind = agent.kind;
    runtime.agentCommand = agent.command;
    runtime.agentBinary = agent.command;
    runtime.agentArgs = agent.args;
    await writeRuntimeRecord(runtime);
    delete normalized.OPENCODE_CONFIG_CONTENT;
  } else {
    const path = resolve(env.HOME ?? '/root', '.pi/agent/models.json');
    const persisted = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
    const provider = persisted.providers?.beeline;
    const model = runtime.modelSelection?.model;
    if (provider?.baseUrl && model?.startsWith('beeline/')) {
      const upstreamModel = model.slice('beeline/'.length);
      await writePrivate(path, freeAgentPiConfig({ modelBaseUrl: provider.baseUrl, upstreamModel },
        await freeAgentInput(upstreamModel)));
    }
  }
  const reconciled = `${Object.entries(normalized).map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
  if (reconciled !== original) await writePrivateFileAtomically(runtime.llmEnvFile, reconciled);
}

/**
 * POST the idle report; the server answers whether it will sleep this Machine.
 * `refresh` asks for a stop instead of a suspend, so the next boot installs
 * the newer helper release the server announced.
 */
export async function requestFreeAgentSleep(
  configPath: string,
  options: { refresh?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const transport = (await readRuntimeRecord(configPath)).transport;
  if (!transport || !('daemonToken' in transport) || !transport.daemonToken)
    throw new Error('free agent has no daemon token');
  const response = await fetchImpl(new URL('/v1/free-agents/sleep', transport.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${transport.daemonToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: options.refresh === true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`sleep request failed: HTTP ${response.status}`);
  return ((await response.json()) as { sleep?: unknown }).sleep === true;
}

export async function runFreeAgentCommand(env: NodeJS.ProcessEnv = process.env) {
  const startedAt = performance.now();
  const startupStep = (step: string) => console.info(`[free-agent] boot ${new Date().toISOString()} step=${step} elapsedMs=${Math.round(performance.now() - startedAt)}`);
  startupStep('command');
  const agentId = env.BEELINE_FREE_AGENT_ID?.trim().toLowerCase() ?? '';
  const serverUrl = env.BEELINE_SERVER_URL?.trim() ?? '';
  if (!/^[0-9a-f]{64}$/.test(agentId)) throw new Error('BEELINE_FREE_AGENT_ID is required');
  if (!/^https?:\/\//.test(serverUrl)) throw new Error('BEELINE_SERVER_URL is required');
  const supervisorRoot = defaultSupervisorRoot(env);
  const configPath = runtimeConfigPath(supervisorRoot, agentId);
  if (!(await hasDaemonToken(configPath))) {
    const token = env.BEELINE_FREE_AGENT_BOOTSTRAP?.trim();
    if (!token) throw new Error('BEELINE_FREE_AGENT_BOOTSTRAP is required for the first boot');
    // A first boot that died before activating left an exchange-only record.
    await rm(runtimeDirectory(supervisorRoot, agentId), { recursive: true, force: true });
    const grant = await fetchFreeAgentGrant(serverUrl, token);
    startupStep('bootstrap');
    if (grant.agentId !== agentId) throw new Error('free agent bootstrap returned another agent');
    await stageFreeAgent(env, grant);
    console.log(`[free-agent] staged agent ${agentId.slice(0, 12)} for ${grant.workspaceName}`);
  }
  startupStep('staged');
  await upgradeFreeAgentHarness(configPath, env);
  startupStep('harness');
  const settings = JSON.parse(
    await readFile(resolve(supervisorRoot, 'beeline', 'free-agent', 'settings.json'), 'utf8'),
  ) as FreeAgentSettings;
  startupStep('helper-start');
  return runMachineHelper({
    configPaths: [configPath],
    env,
    freeAgentIdle: {
      idleMs: Math.max(10, settings.idleSeconds) * 1_000,
      requestSleep: (sleep) => requestFreeAgentSleep(configPath, sleep),
    },
  });
}
