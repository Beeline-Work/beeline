import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import { normalizeAgentPairingCode } from '@beeline/api-contract/phone';
import { AGENT_NAME_MAX_LENGTH, isReasonableAgentName } from '@beeline/buzz-client';
import { AUTO_DETECT_AGENT_KINDS, resolveAgentCommand, type AgentKind } from './agent-command.js';
import { clackPromptOutput, unwrapPrompt } from './clack-support.js';
import { fetchAgentModelCatalog } from './model-catalog.js';
import { completeDevicePairing, type DevicePairingGrant } from './pair-command.js';
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
export const CONNECT_PROVIDER_HARNESSES = new Set<AgentKind>(['goose', 'pi']);
export const CONNECT_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'google', 'xai'] as const;
export type ConnectProvider = (typeof CONNECT_PROVIDERS)[number];

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

export interface ConnectWizardResult {
  name: string;
  harness: (typeof CONNECT_HARNESSES)[number];
  provider?: ConnectProvider;
  apiKey?: string;
  model: string;
  soul: string;
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

export function brass(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  output: NodeJS.WriteStream = stdout,
): string {
  const level = brassEnabled(env, output);
  if (level === 'truecolor') return `\u001b[38;2;194;147;60m${value}\u001b[39m`;
  if (level === '256') return `\u001b[38;5;178m${value}\u001b[39m`;
  return value;
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
};

async function loadConnectModelCatalog(input: {
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
  const modelAxis = catalog.catalog.find((axis) => axis.category === 'model');
  if (!modelAxis?.options.length) {
    throw new Error(`${input.harness} did not advertise any available models`);
  }
  return { currentValue: modelAxis.currentValue, options: modelAxis.options };
}

export async function collectConnectWizard(
  prompts: ConnectPrompts = clackPrompts,
  loadModels: (input: {
    harness: ConnectWizardResult['harness'];
    provider?: ConnectProvider;
    apiKey?: string;
  }) => Promise<ConnectModelCatalog> = loadConnectModelCatalog,
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
    apiKey = await prompts.password({
      message: brass(`${provider === 'openrouter' ? 'OpenRouter' : provider} API key`),
      validate: (value) => (value.trim() ? undefined : 'API key is required'),
    });
  }
  const catalog = await loadModels({
    harness,
    ...(provider ? { provider } : {}),
    ...(apiKey ? { apiKey: apiKey.trim() } : {}),
  });
  const initialModel = catalog.currentValue ?? defaultConnectModel(harness, provider);
  const model = await prompts.autocomplete({
    message: brass('Choose model'),
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
  const name = await prompts.text({
    message: brass('Agent name'),
    validate: (value) => {
      if (!value.trim()) return 'Agent name is required';
      return isReasonableAgentName(value)
        ? undefined
        : `Use letters, spaces, hyphens, or apostrophes (${AGENT_NAME_MAX_LENGTH} characters max)`;
    },
  });
  const soul = await prompts.text({
    message: brass('Input soul'),
    validate: (value) => (value.trim() ? undefined : 'Soul is required'),
  });
  return {
    name: name.trim().replace(/\s+/g, ' '),
    harness,
    ...(provider ? { provider } : {}),
    ...(apiKey ? { apiKey: apiKey.trim() } : {}),
    model: model.trim(),
    soul: soul.trim(),
  };
}

export interface DeviceGrantResponse {
  agent_secret_key: string;
  agent_pubkey: string;
  body_secret_key: string;
  daemon_exchange_token: string;
  agent_name: string;
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
  return jsonRequest<DeviceGrantResponse>(
    `${baseUrl}/auth/agent/connect`,
    {
      pairing_code: normalizedPairingCode,
      harness: selection.harness,
      ...(selection.provider ? { provider: selection.provider } : {}),
      model: selection.model,
      soul: selection.soul,
      agent_name: selection.name,
    },
    fetchImpl,
  );
}

async function installCurrentRelease(fetchImpl: typeof fetch): Promise<string> {
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
  return resolve(layout.binDir, 'beeline');
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

async function brassSpinner<T>(message: string, action: () => Promise<T>): Promise<T> {
  const spinner = clack.spinner({ output: clackPromptOutput() });
  spinner.start(brass(message));
  try {
    const result = await action();
    spinner.stop(brass('Done'));
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
  clack.intro(brass('Beeline connect'));
  const pairingCode =
    code?.trim() ||
    (await clackPrompts.text({
      message: brass('Pairing code from the app'),
      validate: (value) =>
        normalizeAgentPairingCode(value) ? undefined : 'Enter the pairing code shown in the app',
    }));
  const selection = await collectConnectWizard();
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (process.env.BEELINE_AUTH_URL ?? 'https://server.usebeeline.app').replace(
    /\/$/,
    '',
  );
  const grant = await brassSpinner('Connecting to your Beeline Workspace…', () =>
    requestConnectGrant(baseUrl, pairingCode, selection, fetchImpl),
  );
  const installedBinary = await brassSpinner('Installing the Beeline daemon…', () =>
    installCurrentRelease(fetchImpl),
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
  await brassSpinner('Starting your agent…', () => runInstalledFinish(installedBinary, grantPath));
  console.log('');
  console.log(`${brass('Agent')}      ${grant.agent_name}`);
  console.log(`${brass('Workspace')}  ${grant.workspace_name}`);
  clack.outro(brass('Say hi in the app.'));
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

export async function runConnectFinishCommand(path: string | undefined): Promise<void> {
  if (!path) throw new Error('connect-finish requires a grant path');
  if (!isCanonicalInstalledLauncher(process.env, process.argv[1])) {
    throw new Error('connect-finish may run only from the canonical installed Beeline launcher');
  }
  const grant = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  if (!isDevicePairingGrant(grant)) throw new Error('device connection grant is invalid');
  await completeDevicePairing(grant);
  await unlink(resolve(path));
}
