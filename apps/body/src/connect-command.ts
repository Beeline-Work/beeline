import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import { agentBehavior, AUTO_DETECT_AGENT_KINDS, detectInstalledAgentCommands, installLatestAgentAdapter, requireInstalledAgentProgram, installedAgentProgramEnvironment, resolveAgentCommand, type AgentCommand, type AgentKind, type DetectedAgentCommand } from './agent-command.js';
import { clackPromptOutput, unwrapPrompt } from './clack-support.js';
import { enumerateCursorModels } from './cursor-models.js';
import { fetchAgentModelCatalog } from './model-catalog.js';
import { verifyProviderKey, type ConnectKeyProvider } from './provider-key-check.js';
import { maskProviderKey, PROVIDER_KEY_ENV_VARS, providerKeyFromEnvironment, readSavedProviderKey, saveProviderKey, type ProviderKeyProvider } from './provider-key-store.js';
import { providerEnvironment } from './connect-command-parse-connect-subscriptions.js';
export { parseConnectSubscriptions, readMachineId, requestConnectGrant, renameConnectedAgent, finishConnectedAgentPairing, seededIdentityLine, brassSpinner, runConnectCommand, confirmSeededName, connectPlainFailure, ConnectFailureError, runConnectFinishCommand } from './connect-command-parse-connect-subscriptions.js';



export const CONNECT_HARNESSES = AUTO_DETECT_AGENT_KINDS;

export const AGENT_NAME_MAX_LENGTH = 32;


/**
 * Connect needs a keyboard-backed input stream. Some mobile terminal shells
 * proxy stdout through their UI, so it is writable but does not identify as a
 * TTY. Requiring that output stream to be a TTY rejects a person who can still
 * answer every prompt.
 */
export function isInteractiveConnectTerminal(
  input: Pick<NodeJS.ReadStream, 'isTTY'> = stdin,
): boolean {
  return input.isTTY === true;
}


export function isReasonableAgentName(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return (
    normalized.length > 0 &&
    normalized.length <= AGENT_NAME_MAX_LENGTH &&
    /^\p{L}[\p{L}\p{M}'’ -]*$/u.test(normalized)
  );
}

export const CONNECT_PROVIDER_HARNESSES = new Set<AgentKind>(['goose', 'pi']);

export const CONNECT_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'google', 'xai'] as const;

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


export const DEFAULT_MODELS: Record<
  ConnectProvider | 'codex' | 'claude' | 'grok' | 'cursor' | 'opencode',
  string
> = {
  openrouter: 'z-ai/glm-5.3-flash',
  openai: 'gpt-5.4',
  anthropic: 'claude-opus-4-1',
  google: 'gemini-2.5-pro',
  xai: 'grok-4',
  codex: 'gpt-5.4',
  claude: 'claude-opus-4-1',
  grok: 'grok-4',
  // cursor-agent's own default; always served, and the only model safe to
  // assume before `cursor-agent models` has been read.
  cursor: 'auto',
  opencode: 'opencode/big-pickle',
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
  /** Only set when the harness advertises a reasoning-effort axis to choose from. */
  effort?: string;
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
    : (DEFAULT_MODELS[harness as 'codex' | 'claude' | 'grok' | 'cursor' | 'opencode'] ?? 'default');
}


export function brassEnabled(
  env: NodeJS.ProcessEnv,
  output: NodeJS.WriteStream,
): 'truecolor' | '256' | 'plain' {
  if (env.NO_COLOR !== undefined || !output.isTTY) return 'plain';
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor';
  if (/256color/i.test(env.TERM ?? '')) return '256';
  return 'plain';
}


/** The one brand brass, #D7AF5F — the app's accent, and xterm 179 exactly. */
export const BRASS_TRUECOLOR = '\u001b[38;2;215;175;95m';

export const BRASS_256 = '\u001b[38;5;179m';


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


export const clackPrompts: ConnectPrompts = {
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


export type ConnectAxisPicker = {
  currentValue?: string;
  options: Array<{ id: string; name?: string }>;
};


export type ConnectModelCatalog = ConnectAxisPicker & {
  note?: string;
  /** The harness's reasoning-effort axis, when it advertises one. */
  effort?: ConnectAxisPicker;
};


/**
 * The categories a harness spells its reasoning-effort axis with. Codex says
 * `effort`, Claude says `thought_level`, others say `reasoning_effort`; all
 * three are the same question to a person.
 */
export const CONNECT_EFFORT_CATEGORIES = ['effort', 'reasoning_effort', 'thought_level'];


/**
 * The effort picker, from the safe view when it kept the axis and the raw
 * advertised axes otherwise. A harness with no such axis has nothing to ask
 * about, so the wizard skips the question rather than inventing a ladder.
 */
export function connectEffortPickerFromAxes(
  axes: Array<{ category: string; currentValue?: string; options: Array<{ id: string }> }>,
  rawAxes = axes,
): ConnectAxisPicker | undefined {
  const isEffort = (axis: { category: string; options: Array<{ id: string }> }): boolean =>
    CONNECT_EFFORT_CATEGORIES.includes(axis.category) && axis.options.length > 0;
  const axis = axes.find(isEffort) ?? rawAxes.find(isEffort);
  return axis ? { currentValue: axis.currentValue, options: axis.options } : undefined;
}


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


export interface ConnectModelCatalogRequest {
  harness: ConnectWizardResult['harness'];
  provider?: ConnectProvider;
  apiKey?: string;
  /**
   * Read the catalog as this model rather than the provider default. Effort
   * ladders can be model-specific, so the wizard re-reads under the model the
   * person just picked before asking what effort it should run at.
   */
  model?: string;
  /** Bound the read; the discovery probe sets one, the credentialed read does not. */
}


export interface ConnectModelCatalogDependencies {
  refreshAdapter?: (kind: AgentKind) => Promise<unknown>;
  resolveAgent?: (kind: AgentKind) => Pick<AgentCommand, 'kind' | 'command' | 'args'>;
  fetchCatalog?: typeof fetchAgentModelCatalog;
}


export const refreshedConnectAdapters = new Map<AgentKind, Promise<unknown>>();


export function refreshConnectAdapter(kind: AgentKind): Promise<unknown> {
  const existing = refreshedConnectAdapters.get(kind);
  if (existing) return existing;
  const refresh = installLatestAgentAdapter(kind).catch((error) => {
    refreshedConnectAdapters.delete(kind);
    throw error;
  });
  refreshedConnectAdapters.set(kind, refresh);
  return refresh;
}


export async function loadConnectModelCatalog(
  input: ConnectModelCatalogRequest,
  dependencies: ConnectModelCatalogDependencies = {},
): Promise<ConnectModelCatalog> {
  if (!dependencies.resolveAgent) requireInstalledAgentProgram(input.harness);
  // Resolve only after the refresh. Otherwise the wizard can interrogate an
  // old adapter, persist its model id, then launch a different adapter from a
  // later PATH resolution. A picker choice must come from the exact command
  // that connect-finish will store for the daemon.
  await (dependencies.refreshAdapter ?? refreshConnectAdapter)(input.harness);
  const agent = (dependencies.resolveAgent ?? ((kind) => resolveAgentCommand({ kind })))(
    input.harness,
  );
  const model = input.model ?? defaultConnectModel(input.harness, input.provider);
  const catalog = await (dependencies.fetchCatalog ?? fetchAgentModelCatalog)(
    agent,
    { ...installedAgentProgramEnvironment(input.harness), ...providerEnvironment({
      harness: input.harness,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      model,
    }) },
    input.model ? { model: input.model } : undefined,
  );
  const effort = connectEffortPickerFromAxes(catalog.catalog, catalog.raw);
  const picker = connectModelPickerFromAxes(
    catalog.catalog,
    defaultConnectModel(input.harness, input.provider),
    input.harness,
    catalog.raw,
  );
  // cursor-agent advertises models through Beeline's ACP bridge at
  // `session/new`; this CLI read remains the fallback when that catalog is empty.
  if (
    agentBehavior(input.harness).cliModelCatalog &&
    !catalog.catalog.some((axis) => axis.category === 'model' && axis.options.length) &&
    !catalog.raw.some((axis) => axis.category === 'model' && axis.options.length)
  ) {
    const cliModels = await enumerateCursorModels();
    if (cliModels) return { ...cliModels, ...(effort ? { effort } : {}) };
  }
  return {
    ...picker,
    ...(effort ? { effort } : {}),
  };
}


/**
 * How long the wizard waits for a harness to say what it can do before it
 * gives up and asks instead — the WHOLE read, handshake through live
 * validation of every advertised model (`loadConnectModelCatalog` exercises
 * each candidate through the harness's real setter before offering it, one
 * ACP round trip apiece). A configured harness answers the ACP handshake plus
 * `session/new` in about three seconds on a warm machine (measured: goose
 * 1.41 against a live OpenRouter config, 3.0s, nearly all of it `session/new`
 * loading extensions); claude-agent-acp's per-model validation adds roughly a
 * further second per numbered model on top of that (measured: claude-agent-acp
 * 0.84.0, ~12 models, ~13s of validation alone). Twenty-five seconds covers
 * that with room for a cold binary on a loaded machine, while a spinner
 * covers the wait itself so nobody reads it as hung. There is exactly one
 * attempt: a harness that needs longer than this is one the person should
 * simply be asked about.
 */

/**
 * A catalog is evidence that a harness is already configured only when the
 * harness itself enumerated models. `connectModelPickerFromAxes` synthesises
 * a one-entry picker with a `note` when it enumerated nothing; that entry is
 * the provider default, which is exactly what the wizard must not mistake for
 * an observation.
 */
export function connectProbeFoundModels(catalog: ConnectModelCatalog): boolean {
  return catalog.note === undefined && catalog.options.length > 0;
}


/**
 * The one harness worth auto-selecting: the only supported harness actually
 * installed on this machine. Anything else — none, or several — is a genuine
 * choice, so the list is offered.
 */
export function soleInstalledConnectHarness(
  detected: DetectedAgentCommand[],
): (typeof CONNECT_HARNESSES)[number] | undefined {
  const ready = detected.filter((entry) => entry.status === 'ready');
  return ready.length === 1 ? ready[0]!.kind : undefined;
}


export function connectHarnessLabel(harness: (typeof CONNECT_HARNESSES)[number]): string {
  return agentBehavior(harness).label ?? harness[0]!.toUpperCase() + harness.slice(1);
}


/**
 * What the probe found, said once: it stands in for the provider and key
 * questions it answered, and explains where the model prompt's default came
 * from.
 */
export function connectFoundLine(input: {
  harness: (typeof CONNECT_HARNESSES)[number];
  sole: boolean;
  model?: string;
}): string {
  const name = connectHarnessLabel(input.harness);
  const found = input.sole
    ? `${name} is the only harness installed here, and it is already set up`
    : `${name} is already set up`;
  return input.model ? `${found}, running ${input.model}.` : `${found}.`;
}


export interface ConnectWizardSeams {
  /** Supported harnesses installed on this machine; defaults to a real scan. */
  detect?: () => DetectedAgentCommand[];
  checkProgram?: (kind: AgentKind, env: NodeJS.ProcessEnv) => void;
  /** Where the wizard says what it found instead of asking for it. */
  announce?: (line: string) => void;
}


/**
 * Ask before assuming — except about what the agent will think with. Setup
 * facts the machine can establish it establishes: it checks the chosen harness
 * before asking for its provider and key (asked only when
 * the harness holds none; a harness that answers `session/new` with its own
 * model list is authenticated by definition). Model and reasoning effort are
 * always asked, including of an already-configured harness: the harness's
 * current selection is the default offered, never a silent answer. It used to
 * be taken as one, which left people connected to whatever their harness
 * happened to be set to with no say and no way back but the app.
 */
export async function collectConnectWizard(
  prompts: ConnectPrompts = clackPrompts,
  loadModels: (
    input: ConnectModelCatalogRequest,
  ) => Promise<ConnectModelCatalog> = loadConnectModelCatalog,
  keyStore: ConnectKeyStore = fileConnectKeyStore,
  env: NodeJS.ProcessEnv = process.env,
  verifyKey: (input: { provider: ConnectProvider; apiKey: string }) => Promise<void> = (input) =>
    verifyProviderKey(input as { provider: ConnectKeyProvider; apiKey: string }),
  seams: ConnectWizardSeams = {},
): Promise<ConnectWizardResult> {
  const announce = seams.announce ?? ((line: string) => clack.log.info(brass(line)));
  const askModel = async (
    catalog: ConnectModelCatalog,
    forHarness: (typeof CONNECT_HARNESSES)[number],
    forProvider?: ConnectProvider,
  ): Promise<string> => {
    const initialModel = catalog.currentValue ?? defaultConnectModel(forHarness, forProvider);
    const picked = await prompts.autocomplete({
      message: brass(catalog.note ? `Choose model (${catalog.note})` : 'Choose model'),
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
    return (picked ?? '').trim();
  };
  /**
   * Reasoning effort, asked whenever the harness advertises the axis. Ladders
   * can be model-specific, so a model other than the one the catalog was read
   * under earns one more bounded read: the ladder offered is then the chosen
   * model's own, and the value cannot be refused later by the session that
   * validates it. A re-read that fails or runs long keeps the ladder already
   * in hand rather than dropping the question.
   */
  const askEffort = async (
    catalog: ConnectModelCatalog,
    forHarness: (typeof CONNECT_HARNESSES)[number],
    model: string,
    forProvider?: ConnectProvider,
    forKey?: string,
  ): Promise<string | undefined> => {
    let axis = catalog.effort;
    if (model !== catalog.currentValue) {
      const reread = await loadModels({
        harness: forHarness,
        model,
        ...(forProvider ? { provider: forProvider } : {}),
        ...(forKey ? { apiKey: forKey } : {}),
      }).catch(() => undefined);
      axis = reread?.effort ?? axis;
    }
    if (!axis?.options.length) return undefined;
    const picked = await prompts.select<string>({
      message: brass('Choose reasoning effort'),
      options: axis.options.map((choice) => ({
        value: choice.id,
        label: choice.name ?? choice.id,
        ...(choice.id === axis.currentValue ? { hint: 'current' } : {}),
      })),
      ...(axis.options.some((choice) => choice.id === axis.currentValue)
        ? { initialValue: axis.currentValue! }
        : {}),
    });
    return (picked ?? '').trim();
  };
  // One bounded attempt, and never a hard failure: a harness that times out,
  // refuses or crashes is simply one the wizard has to ask about. The read
  // itself can take several seconds (claude-agent-acp live-validates every
  // advertised model), so a spinner covers the wait — without it, the wizard
  // sits at "Choose harness" with nothing on screen and reads as hung.
  const probe = async (
    candidate: (typeof CONNECT_HARNESSES)[number],
  ): Promise<ConnectModelCatalog | undefined> => {
    const spinner = clack.spinner({ output: clackPromptOutput() });
    spinner.start(brass(`Checking ${connectHarnessLabel(candidate)}…`));
    try {
      const catalog = await loadModels({
        harness: candidate,
      });
      spinner.stop();
      return connectProbeFoundModels(catalog) ? catalog : undefined;
    } catch {
      spinner.stop();
      return undefined;
    }
  };

  const detected = (seams.detect ?? detectInstalledAgentCommands)();
  const sole = soleInstalledConnectHarness(detected);
  const harness = await prompts.select<(typeof CONNECT_HARNESSES)[number]>({
    message: brass('Choose harness'),
    options: CONNECT_HARNESSES.map(value => ({ value, label: connectHarnessLabel(value) })),
    ...(sole ? { initialValue: sole } : {}),
  });
  const checkProgram = seams.checkProgram ?? requireInstalledAgentProgram;
  checkProgram(harness, env);
  const configured = await probe(harness);
  if (configured) {
    announce(
      connectFoundLine({
        harness,
        sole: harness === sole,
        ...(configured.currentValue ? { model: configured.currentValue } : {}),
      }),
    );
    // What the harness is set to is the default, not the decision: both
    // questions are still asked, with its own current values pre-selected.
    const model = await askModel(configured, harness);
    const effort = await askEffort(configured, harness, model);
    return { harness, model, ...(effort ? { effort } : {}) };
  }
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
  // Unbounded, exactly as before: the wizard is committed to this harness now,
  // so a slow catalog read is worth waiting for and a failed one is worth
  // reporting rather than swallowing.
  const catalog = await loadModels({
    harness,
    ...(provider ? { provider } : {}),
    ...(apiKey ? { apiKey: apiKey.trim() } : {}),
  });
  const model = await askModel(catalog, harness, provider);
  const effort = await askEffort(catalog, harness, model, provider, apiKey?.trim());
  return {
    harness,
    ...(provider ? { provider } : {}),
    ...(apiKey ? { apiKey: apiKey.trim() } : {}),
    model,
    ...(effort ? { effort } : {}),
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
  workspace_joined: boolean;
  paired_by: string;
  harness: ConnectWizardResult['harness'];
  provider?: ConnectProvider;
  model: string;
  effort?: string;
  soul: string;
}


export async function jsonRequest<T>(url: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: undefined,
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
