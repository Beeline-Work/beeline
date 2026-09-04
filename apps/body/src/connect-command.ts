import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import { normalizeAgentPairingCode } from '@beeline/api-contract/phone';
import { AUTO_DETECT_AGENT_KINDS, resolveAgentCommand, type AgentKind } from './agent-command.js';
import { clackPromptOutput, unwrapPrompt } from './clack-support.js';
import { fetchAgentModelCatalog } from './model-catalog.js';
import { verifyProviderKey, type ConnectKeyProvider } from './provider-key-check.js';
import { completeDevicePairing, type DevicePairingGrant } from './device-pairing.js';
import {
  openRouterModelId,
  openRouterRoutingCacheDir,
  resolveOpenRouterRouting,
} from './openrouter-routing.js';
import {
  maskProviderKey,
  PROVIDER_KEY_ENV_VARS,
  providerKeyFromEnvironment,
  readSavedProviderKey,
  saveProviderKey,
  type ProviderKeyProvider,
} from './provider-key-store.js';
import {
  activateRelease,
  defaultBeelineInstallLayout,
  hostPlatformKey,
  stageRelease,
} from './self-update.js';
import { isCanonicalInstalledLauncher } from './systemd.js';
import { parseUpdateManifest, resolveManifestUrl } from './self-update-manifest.js';
import { defaultSupervisorRoot } from './runtime.js';

export const CONNECT_HARNESSES = AUTO_DETECT_AGENT_KINDS;
export const AGENT_NAME_MAX_LENGTH = 32;

function isReasonableAgentName(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return (
    normalized.length > 0 &&
    normalized.length <= AGENT_NAME_MAX_LENGTH &&
    /^\p{L}[\p{L}\p{M}'’ -]*$/u.test(normalized)
  );
}
export const CONNECT_PROVIDER_HARNESSES = new Set<AgentKind>(['goose', 'pi']);
export const CONNECT_PROVIDERS = [
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'xai',
] as const;
export type ConnectProvider = (typeof CONNECT_PROVIDERS)[number];

/** Saved-key access seam so tests can stub the on-disk store. */
export interface ConnectKeyStore {
  read(provider: ConnectProvider): Promise<string | undefined>;
  save(provider: ConnectProvider, key: string): Promise<void>;
}

export const fileConnectKeyStore: ConnectKeyStore = {
  read: (provider: ProviderKeyProvider) => readSavedProviderKey(provider),
  save: (provider: ProviderKeyProvider, key: string) => saveProviderKey(provider, key),
};

const DEFAULT_MODELS: Record<ConnectProvider | 'codex' | 'claude' | 'grok', string> = {
  openrouter: 'z-ai/glm-5.3-flash',
  openai: 'gpt-5.4',
  anthropic: 'claude-opus-4-1',
  google: 'gemini-2.5-pro',
  xai: 'grok-4',
  codex: 'gpt-5.4',
  claude: 'claude-opus-4-1',
  grok: 'grok-4',
};

/**
 * What the wizard still asks for. Name and soul are NOT here: the server seeds
 * both from the animal it assigns the agent, so nobody types them.
 */
export interface ConnectWizardResult {
  harness: (typeof CONNECT_HARNESSES)[number];
  provider?: ConnectProvider;
  apiKey?: string;
  model: string;
}

export interface ConnectPrompts {
  select<T extends string>(input: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T>;
  autocomplete(input: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string;
    placeholder?: string;
    maxItems?: number;
  }): Promise<string>;
  text(input: {
    message: string;
    initialValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  password(input: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
}

export function connectHarnessNeedsProvider(harness: AgentKind): boolean {
  return CONNECT_PROVIDER_HARNESSES.has(harness);
}

export function defaultConnectModel(
  harness: (typeof CONNECT_HARNESSES)[number],
  provider?: ConnectProvider,
): string {
  return provider
    ? DEFAULT_MODELS[provider]
    : (DEFAULT_MODELS[harness as 'codex' | 'claude' | 'grok'] ?? 'default');
}

function brassEnabled(
  env: NodeJS.ProcessEnv,
  output: NodeJS.WriteStream,
): 'truecolor' | '256' | 'plain' {
  if (env.NO_COLOR !== undefined || !output.isTTY) return 'plain';
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor';
  if (/256color/i.test(env.TERM ?? '')) return '256';
  return 'plain';
}

/** The one brand brass, #D7AF5F — the app's accent, and xterm 179 exactly. */
const BRASS_TRUECOLOR = '\u001b[38;2;215;175;95m';
const BRASS_256 = '\u001b[38;5;179m';

export function brass(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  output: NodeJS.WriteStream = stdout,
): string {
  const level = brassEnabled(env, output);
  if (level === 'truecolor') return `${BRASS_TRUECOLOR}${value}\u001b[39m`;
  if (level === '256') return `${BRASS_256}${value}\u001b[39m`;
  return value;
}

/**
 * Clack paints its rails — the active step symbol, the selected option, the
 * submitted value — cyan, and there is no colour hook to ask it otherwise.
 * Repaint that one colour brass on the way out so the wizard reads as the app
 * does. Nothing else about the frame changes.
 */
export function brassRails(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  output: NodeJS.WriteStream = stdout,
): string {
  const level = brassEnabled(env, output);
  if (level === 'plain') return text;
  return text.replace(/\u001b\[(?:36|96)m/g, level === 'truecolor' ? BRASS_TRUECOLOR : BRASS_256);
}

/** Hold the repaint for the life of the wizard; the return restores the stream. */
export function paintWizardBrass(output: NodeJS.WriteStream = stdout): () => void {
  const original = output.write;
  const patched = function write(this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
    return (original as unknown as (...args: unknown[]) => boolean).call(
      this,
      typeof chunk === 'string' ? brassRails(chunk, process.env, output) : chunk,
      ...rest,
    );
  };
  output.write = patched as unknown as NodeJS.WriteStream['write'];
  return () => {
    output.write = original;
  };
}

const clackPrompts: ConnectPrompts = {
  async select<T extends string>(input: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }) {
    clackPromptOutput();
    return unwrapPrompt(
      await clack.select<T>(input as clack.SelectOptions<T>),
      'Connection cancelled.',
    );
  },
  async autocomplete(input: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string;
    placeholder?: string;
    maxItems?: number;
  }) {
    clackPromptOutput();
    return unwrapPrompt(
      await clack.autocomplete<string>({ ...input, output: clackPromptOutput() }),
      'Connection cancelled.',
    );
  },
  async text(input) {
    clackPromptOutput();
    return unwrapPrompt(
      await clack.text({
        ...input,
        validate: input.validate ? (value) => input.validate!(value ?? '') : undefined,
      }),
      'Connection cancelled.',
    );
  },
  async password(input) {
    clackPromptOutput();
    return unwrapPrompt(
      await clack.password({
        ...input,
        validate: input.validate ? (value) => input.validate!(value ?? '') : undefined,
      }),
      'Connection cancelled.',
    );
  },
};

type ConnectModelCatalog = {
  currentValue?: string;
  options: Array<{ id: string; name?: string }>;
  note?: string;
};

/**
 * Derive the wizard's model picker from the harness's advertised axes —
 * never a hard failure. Prefer the catalog authority's safe view, retaining
 * the raw advertised axis as a defensive fallback for adapters whose routed
 * model identifiers cannot be classified generically. If the harness truly
 * enumerated nothing, the provider default is offered with an explanatory
 * note. The old behavior — throwing "did not advertise any available models"
 * — refused connect runs that were fully serviceable.
 */
export function connectModelPickerFromAxes(
  axes: Array<{ category: string; currentValue?: string; options: Array<{ id: string }> }>,
  fallbackModel: string,
  harness: string,
  rawAxes = axes,
): ConnectModelCatalog {
  const filtered = axes.find((axis) => axis.category === 'model');
  if (filtered?.options.length) {
    return { currentValue: filtered.currentValue, options: filtered.options };
  }
  const raw = rawAxes.find((axis) => axis.category === 'model' && axis.options.length);
  if (raw) {
    return { currentValue: raw.currentValue, options: raw.options };
  }
  return {
    currentValue: fallbackModel,
    options: [{ id: fallbackModel }],
    note: `${harness} did not enumerate models; offering the provider default`,
  };
}

export async function loadConnectModelCatalog(input: {
  harness: ConnectWizardResult['harness'];
  provider?: ConnectProvider;
  apiKey?: string;
}): Promise<ConnectModelCatalog> {
  const agent = resolveAgentCommand({ kind: input.harness });
  const catalog = await fetchAgentModelCatalog(
    agent,
    providerEnvironment({
      harness: input.harness,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      model: defaultConnectModel(input.harness, input.provider),
    }),
  );
  return connectModelPickerFromAxes(
    catalog.catalog,
    defaultConnectModel(input.harness, input.provider),
    input.harness,
    catalog.raw,
  );
}

export async function collectConnectWizard(
  prompts: ConnectPrompts = clackPrompts,
  loadModels: (input: {
    harness: ConnectWizardResult['harness'];
    provider?: ConnectProvider;
    apiKey?: string;
  }) => Promise<ConnectModelCatalog> = loadConnectModelCatalog,
  keyStore: ConnectKeyStore = fileConnectKeyStore,
  env: NodeJS.ProcessEnv = process.env,
  verifyKey: (input: {
    provider: ConnectProvider;
    apiKey: string;
  }) => Promise<void> = (input) =>
    verifyProviderKey(input as { provider: ConnectKeyProvider; apiKey: string }),
): Promise<ConnectWizardResult> {
  const harness = await prompts.select<(typeof CONNECT_HARNESSES)[number]>({
    message: brass('Choose harness'),
    options: CONNECT_HARNESSES.map((value) => ({
      value,
      label: value === 'pi' ? 'Pi' : value[0]!.toUpperCase() + value.slice(1),
    })),
  });
  let provider: ConnectProvider | undefined;
  let apiKey: string | undefined;
  if (connectHarnessNeedsProvider(harness)) {
    provider = await prompts.select<ConnectProvider>({
      message: brass('Choose provider'),
      initialValue: 'openrouter',
      options: CONNECT_PROVIDERS.map((value) => ({
        value,
        label: value === 'openrouter' ? 'OpenRouter' : value[0]!.toUpperCase() + value.slice(1),
        ...(value === 'openrouter' ? { hint: 'default' } : {}),
      })),
    });
    const providerLabel = provider === 'openrouter' ? 'OpenRouter' : provider;
    const savedKey = await keyStore.read(provider);
    const envKey = providerKeyFromEnvironment(provider, env);
    const availableKey = savedKey ?? envKey;
    if (availableKey) {
      const masked = maskProviderKey(availableKey);
      const choice = await prompts.select<'saved' | 'new'>({
        message: brass(`${providerLabel} API key`),
        initialValue: 'saved',
        options: [
          {
            value: 'saved',
            label: savedKey
              ? `Use saved ${providerLabel} key (${masked})`
              : `Use ${PROVIDER_KEY_ENV_VARS[provider]} from the environment (${masked})`,
          },
          { value: 'new', label: 'Enter a new key' },
        ],
      });
      if (choice === 'saved') {
        apiKey = availableKey;
        await verifyKey({ provider, apiKey });
      } else {
        apiKey = await prompts.password({
          message: brass(`${providerLabel} API key`),
          validate: (value) => (value.trim() ? undefined : 'API key is required'),
        });
        apiKey = apiKey.trim();
        await verifyKey({ provider, apiKey });
        await keyStore.save(provider, apiKey);
      }
    } else {
      apiKey = await prompts.password({
        message: brass(`${providerLabel} API key`),
        validate: (value) => (value.trim() ? undefined : 'API key is required'),
      });
      apiKey = apiKey.trim();
      await verifyKey({ provider, apiKey });
      await keyStore.save(provider, apiKey);
    }
  }
  const catalog = await loadModels({
    harness,
    ...(provider ? { provider } : {}),
    ...(apiKey ? { apiKey: apiKey.trim() } : {}),
  });
  const initialModel = catalog.currentValue ?? defaultConnectModel(harness, provider);
  const model = await prompts.autocomplete({
    message: brass(
      catalog.note ? `Choose model (${catalog.note})` : 'Choose model',
    ),
    options: catalog.options.map((choice) => ({
      value: choice.id,
      label: choice.name ? `${choice.name} (${choice.id})` : choice.id,
    })),
    ...(catalog.options.some((choice) => choice.id === initialModel)
      ? { initialValue: initialModel }
      : {}),
    placeholder: 'Type to filter available models…',
    maxItems: 12,
  });
  return {
    harness,
    ...(provider ? { provider } : {}),
    ...(apiKey ? { apiKey: apiKey.trim() } : {}),
    model: model.trim(),
  };
}

export interface DeviceGrantResponse {
  agent_secret_key: string;
  agent_pubkey: string;
  body_secret_key: string;
  daemon_exchange_token: string;
  agent_name: string;
  agent_face?: string;
  workspace_id: string;
  workspace_name: string;
  paired_by: string;
  harness: ConnectWizardResult['harness'];
  provider?: ConnectProvider;
  model: string;
  soul: string;
}

async function jsonRequest<T>(url: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new Error(detail.message ?? detail.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function requestConnectGrant(
  baseUrl: string,
  pairingCode: string,
  selection: ConnectWizardResult,
  fetchImpl: typeof fetch,
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
      avatar_seed: avatarSeed,
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

/** `Foxy the fox` — one line naming what to look for in the app. */
export function seededIdentityLine(grant: {
  agent_name: string;
  agent_face?: string;
}): string {
  return grant.agent_face ? `${grant.agent_name} the ${grant.agent_face}` : grant.agent_name;
}

async function installCurrentRelease(
  fetchImpl: typeof fetch,
): Promise<{ binary: string; version: string }> {
  const manifestUrl = resolveManifestUrl(process.env);
  const response = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error(`fetching the Beeline release manifest failed: HTTP ${response.status}`);
  const published = parseUpdateManifest(await response.text(), hostPlatformKey()).bundle;
  const layout = defaultBeelineInstallLayout(process.env);
  const releaseId = await stageRelease(layout, manifestUrl, published, {
    fetchImpl,
    logger: () => {},
  });
  await activateRelease(layout, releaseId);
  return {
    binary: resolve(layout.binDir, 'beeline'),
    version: published.version ?? releaseId,
  };
}

function providerEnvironment(
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
    ...(selection.harness === 'goose'
      ? {
          GOOSE_PROVIDER: selection.provider,
          GOOSE_MODEL: selection.model,
        }
      : {}),
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeProviderEnv(
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

async function runInstalledFinish(binary: string, grantPath: string): Promise<void> {
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

export async function runConnectCommand(
  code: string | undefined,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('`usebeeline connect` needs an interactive terminal');
  }
  const restoreRails = paintWizardBrass();
  try {
    await runConnectWizard(code, options.fetchImpl ?? fetch);
  } finally {
    restoreRails();
  }
}

async function runConnectWizard(
  code: string | undefined,
  fetchImpl: typeof fetch,
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
  const claimed = await brassSpinner(
    'Connecting to your Beeline Workspace…',
    () => requestConnectGrant(baseUrl, pairingCode, selection, fetchImpl),
    (connectedGrant) => `Connected to ${connectedGrant.workspace_name}`,
  );
  // The server seeded this agent's animal, name and soul from its Workspace
  // roster. Show what to look for in the app, and offer the one rename the
  // terminal gets before the helper starts under that name.
  const grant = { ...claimed, agent_name: await confirmSeededName(baseUrl, pairingCode, claimed, fetchImpl) };
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
    soul: grant.soul,
    workspaceId: grant.workspace_id,
    workspaceName: grant.workspace_name,
    pairedBy: grant.paired_by,
    monolithBaseUrl: baseUrl,
    daemonExchangeToken: grant.daemon_exchange_token,
    ...(llmEnvFile ? { llmEnvFile } : {}),
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

function isDevicePairingGrant(value: unknown): value is DevicePairingGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<DevicePairingGrant>;
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
    const model = openRouterModelId(grant.model, {
      OPENROUTER_API_KEY: /^OPENROUTER_API_KEY=\S/m.test(providerEnv) ? 'set' : '',
    });
    if (model) {
      const decision = await resolveOpenRouterRouting({
        model,
        cacheDir: openRouterRoutingCacheDir(dirname(connected.configPath)),
      });
      console.log(decision.line);
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
