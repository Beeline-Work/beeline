import { piNoRetrySettings } from './pi-retry-settings.js';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { NATIVE_SHELL_OUTPUT_SCRIPT, nativeShellHookCommand, nativeShellHookConfig } from './native-shell-output.js';
import { DRAW_AVATAR_SKILL_NAME, drawAvatarSkillMarkdown } from './draw-avatar-skill.js';
import { AGENT_BEHAVIORS, IMPORTED_MCP_KINDS, agentBehavior, type AgentKind } from './agent-command.js';
import { beelineManagedSkills } from './beeline-skill.js';
import { classifyImportedMcpServer, isCodeOwnedHostMcpName } from './mcp-route-class.js';
import { grantedSquireHostRoute, mergeGooseHostRoutes, mergeJsonHostRoutes, mergeTomlHostRoutes, rewriteGrantedHostRoutes } from './host-mcp-route.js';
import { ensureSquireHostDir, squireHostBindPaths } from './squire-host.js';
import { OPENROUTER_MAX_OUTPUT_TOKENS, resolveOpenRouterRouting, withOpenRouterModelRouting, type OpenRouterRoutingDecision } from './openrouter-routing.js';
import { extractTomlSections, tomlChildTableNames } from './toml-section.js';
import { AgentSkillDir, RoomAgentHomeInput, HARNESS_MCP_CONFIGS, CODEX_ROOM_AGENT_LOCKDOWN_TOML, CODEX_ROOM_WEB_SEARCH_TOML, GOOSE_SHARED_CONFIG_FILES, PI_MCP_CONFIG, PI_CUSTOM_MODEL_CONFIG, AgentHomeSecurityError } from './agent-home.js';
import { resolveSharedSkillSources, writeIsolatedHarnessFile, assertRealContainedDirectory, planManagedSkills, materializedSkillManifest, copySafeSkillTree } from './agent-home-plan-managed-skills.js';



/**
 * Provision each harness home's Beeline-managed skills directory and copy the
 * operator's MCP declarations into the home. Best-effort end to end: a missing
 * source is the common case (not every host has every harness), and any
 * failure degrades to a session with fewer skills rather than failing the
 * Room. Unlike credentials, BOTH the MCP copies and the managed skill are
 * REGENERATED on every prepare call so a daemon restart picks up operator
 * config edits and release upgrades; per-entry operator-skill links are
 * repaired when they point somewhere else.
 */
export async function provisionAgentSkillsAndMcp(
  root: string,
  operatorHome: string,
  skillReleaseId: string,
  failClosed: boolean,
  sharedSkills: string[],
  skillDir: AgentSkillDir,
  openRouterRouting: RoomAgentHomeInput['openRouterRouting'],
  isReviewer: boolean,
  grantedHostRoutes: readonly string[],
  extraHostRoutes: Record<string, Record<string, unknown>>,
  agentKind: AgentKind | undefined,
  resourceAuthFile?: string,
  squireScope?: RoomAgentHomeInput['squireScope'],
): Promise<void> {
  const managedSkills = [
    { name: DRAW_AVATAR_SKILL_NAME, content: drawAvatarSkillMarkdown(skillReleaseId) },
    ...beelineManagedSkills(skillReleaseId, { isReviewer }),
  ];
  const shared = await resolveSharedSkillSources(operatorHome, sharedSkills);
  await provisionManagedSkillsDir(
    resolve(root, skillDir, 'skills'),
    managedSkills,
    shared,
    sharedSkills.length === 0,
  );

  for (const config of HARNESS_MCP_CONFIGS) {
    try {
      const source = resolve(operatorHome, config.toml);
      const target = resolve(root, config.dir, 'config.toml');
      const mcpSection = existsSync(source)
        ? localHarnessMcpToml(readFileSync(source, 'utf8'))
        : undefined;
      // A Codex Room needs this config even when the operator shares no MCP
      // servers: Codex otherwise enables internal collaboration by default.
      const section =
        config.roomDefaults
          ? [CODEX_ROOM_AGENT_LOCKDOWN_TOML, CODEX_ROOM_WEB_SEARCH_TOML, mcpSection]
              .filter(Boolean)
              .join('\n')
          : mcpSection;
      // Regeneration is also deletion: if the operator removes the config or
      // its last MCP table, do not leave stale servers active in a Room. Codex
      // retains its required delegation lockdown without shared MCP config.
      if (!section) {
        await unlink(target).catch(() => undefined);
        continue;
      }
      await writeIsolatedHarnessFile(target, section);
    } catch (error) {
      if (failClosed) throw error;
      console.warn(`[body] operator MCP passthrough failed for ${config.dir}:`, error);
    }
  }

  try {
    const gooseConfigDir = resolve(root, 'goose', 'config');
    await mkdir(gooseConfigDir, { recursive: true, mode: 0o700 });
    for (const name of GOOSE_SHARED_CONFIG_FILES) {
      const source = resolve(operatorHome, '.config', 'goose', name);
      const target = resolve(gooseConfigDir, name);
      // Regeneration is deletion too: a config the operator removed must not
      // keep answering in a Room.
      if (existsSync(source)) {
        const body = readFileSync(source, 'utf8');
        await writeIsolatedHarnessFile(
          target,
          name === 'config.yaml' ? localGooseConfig(body) : body,
        );
      } else {
        await unlink(target).catch(() => undefined);
      }
    }
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] operator Goose configuration passthrough failed:', error);
  }

  try {
    const claudeJson = resolve(operatorHome, '.claude.json');
    const claudeTarget = resolve(root, 'claude', '.claude.json');
    const mcpServers = existsSync(claudeJson)
      ? readClaudeUserScopeMcpServers(claudeJson)
      : undefined;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      await writeIsolatedHarnessFile(claudeTarget, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
    } else {
      await unlink(claudeTarget).catch(() => undefined);
    }
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] operator MCP passthrough failed for claude:', error);
  }

  try {
    const piJson = resolve(operatorHome, PI_MCP_CONFIG.source);
    const piTarget = resolve(root, 'pi', PI_MCP_CONFIG.target);
    const mcpServers = existsSync(piJson)
      ? localMcpServers(recordValue(readJsonObject(piJson)?.mcpServers) ?? {})
      : undefined;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      await writeIsolatedHarnessFile(piTarget, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
    } else {
      await unlink(piTarget).catch(() => undefined);
    }
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] operator MCP passthrough failed for pi:', error);
  }

  // Native web reads for Claude Code: both discovery (`WebSearch`) and direct
  // URL retrieval (`WebFetch`) are permission-gated, so the generated isolated
  // settings allow them explicitly. Regenerated on every activation like every
  // other Beeline-owned file in the harness home. Filesystem and command tools
  // remain absent and continue through the Room's fail-closed permission path.
  try {
    const shellHook = resolve(root, 'claude', 'beeline-shell-output.cjs');
    if (process.platform !== 'win32')
      await writeIsolatedHarnessFile(shellHook, NATIVE_SHELL_OUTPUT_SCRIPT);
    const settings = { permissions: { allow: ['WebSearch', 'WebFetch'] },
      ...(process.platform !== 'win32' ? nativeShellHookConfig(nativeShellHookCommand(shellHook, 'claude')) : {}) };
    await writeIsolatedHarnessFile(
      resolve(root, 'claude', 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] claude web-search settings provisioning failed:', error);
  }

  if (agentBehavior(agentKind).nativeShellHook?.config === 'hooks-file' && process.platform !== 'win32') {
    const shellHook = resolve(root, 'cursor', 'beeline-shell-output.cjs');
    await writeIsolatedHarnessFile(shellHook, NATIVE_SHELL_OUTPUT_SCRIPT);
    const config = resolve(root, 'user', '.cursor');
    await mkdir(config, { recursive: true, mode: 0o700 });
    await assertRealContainedDirectory(config, root);
    await writeIsolatedHarnessFile(resolve(config, 'hooks.json'), JSON.stringify({
      version: 1, hooks: { preToolUse: [{ matcher: '^Shell$', command: nativeShellHookCommand(shellHook, 'cursor') }] },
    }));
  }

  await applyGrantedHostRoutes(
    root,
    operatorHome,
    grantedHostRoutes,
    agentKind,
    failClosed,
    resourceAuthFile,
    extraHostRoutes,
    squireScope,
  );
  await provisionPiCustomModelConfig(root, operatorHome, failClosed, openRouterRouting);
  // Keep the transport deadline, but never replay failed provider work.
  // Generate isolated settings rather than inheriting operator retry defaults.
  if (appliesToHarness(agentKind, 'pi')) {
    const settings = {
      httpIdleTimeoutMs: 300_000,
      ...piNoRetrySettings(),
    };
    await writeIsolatedHarnessFile(
      resolve(root, 'pi', 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  }
}


export function appliesToHarness(selected: AgentKind | undefined, harness: AgentKind): boolean {
  return !selected || selected === harness;
}


export async function applyGrantedHostRoutes(
  root: string,
  operatorHome: string,
  granted: readonly string[],
  agentKind: AgentKind | undefined,
  failClosed: boolean,
  resourceAuthFile?: string,
  extraHostRoutes: Record<string, Record<string, unknown>> = {},
  squireScope?: RoomAgentHomeInput['squireScope'],
): Promise<void> {
  if (granted.length === 0) return;
  try {
    if (grantedSquireHostRoute(granted, hostImportedMcpDeclarations({ operatorHome, agentKind })))
      ensureSquireHostDir(operatorHome);
    const routesFor = (kind: AgentKind) =>
      rewriteGrantedHostRoutes(
        { ...hostImportedMcpDeclarations({ operatorHome, agentKind: kind }), ...extraHostRoutes },
        granted,
        operatorHome,
        resourceAuthFile,
        squireScope,
      );
    for (const config of HARNESS_MCP_CONFIGS) {
      if (!appliesToHarness(agentKind, config.dir)) continue;
      const routes = routesFor(config.dir);
      if (Object.keys(routes).length === 0) continue;
      const target = resolve(root, config.dir, 'config.toml');
      const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
      const merged = mergeTomlHostRoutes(existing, routes);
      if (merged) await writeIsolatedHarnessFile(target, merged);
    }
    if (appliesToHarness(agentKind, 'goose')) {
      const routes = routesFor('goose');
      if (Object.keys(routes).length > 0) {
        const gooseConfigDir = resolve(root, 'goose', 'config');
        await mkdir(gooseConfigDir, { recursive: true, mode: 0o700 });
        const target = resolve(gooseConfigDir, 'config.yaml');
        const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
        const merged = mergeGooseHostRoutes(existing, routes);
        if (merged) await writeIsolatedHarnessFile(target, merged);
      }
    }
    if (appliesToHarness(agentKind, 'claude')) {
      const routes = routesFor('claude');
      if (Object.keys(routes).length > 0) {
        const target = resolve(root, 'claude', '.claude.json');
        const parsed = existsSync(target) ? readJsonObject(target) : undefined;
        const merged = mergeJsonHostRoutes(recordValue(parsed?.mcpServers), routes);
        if (merged && Object.keys(merged).length > 0) {
          await writeIsolatedHarnessFile(
            target,
            `${JSON.stringify({ mcpServers: merged }, null, 2)}\n`,
          );
        }
      }
    }
    if (appliesToHarness(agentKind, 'pi')) {
      const routes = routesFor('pi');
      if (Object.keys(routes).length > 0) {
        const target = resolve(root, 'pi', PI_MCP_CONFIG.target);
        const parsed = existsSync(target) ? readJsonObject(target) : undefined;
        const merged = mergeJsonHostRoutes(recordValue(parsed?.mcpServers), routes);
        if (merged && Object.keys(merged).length > 0) {
          await writeIsolatedHarnessFile(
            target,
            `${JSON.stringify({ mcpServers: merged }, null, 2)}\n`,
          );
        }
      }
    }
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] granted host MCP route passthrough failed:', error);
  }
}


export async function provisionPiCustomModelConfig(
  root: string,
  operatorHome: string,
  failClosed: boolean,
  openRouterRouting: RoomAgentHomeInput['openRouterRouting'],
): Promise<void> {
  const source = resolve(operatorHome, PI_CUSTOM_MODEL_CONFIG.source);
  const target = resolve(root, 'pi', PI_CUSTOM_MODEL_CONFIG.target);
  // One decision per activation, one log line; never a failed activation.
  let decision: OpenRouterRoutingDecision | undefined;
  if (openRouterRouting) {
    decision = await resolveOpenRouterRouting(openRouterRouting);
    console.log(decision.line);
    openRouterRouting.onDecision?.(decision);
    // The answer probe never blocks an activation; its own line lands when the
    // probe does, and the pin it produces is read by the NEXT activation.
    void decision.refresh
      ?.then((next) => {
        if (next) console.log(next.line);
      })
      .catch(() => undefined);
  }
  const pin = decision
    ? {
        model: decision.model,
        routing: decision.routing,
        // The model's live input modalities ride with the routing pin: a
        // custom-model entry replaces pi's catalog record and defaults it to
        // text, which strips every image from the prompt (C87).
        ...(decision.input ? { input: decision.input } : {}),
        // The routed endpoints' window and output cap replace pi's catalog
        // values, which can ask for more output than the window leaves. With
        // no listing to read, the output cap alone still applies.
        limits: decision.limits ?? { maxTokens: OPENROUTER_MAX_OUTPUT_TOKENS },
      }
    : undefined;
  try {
    const sourceStats = await lstat(source).catch(() => undefined);
    if (!sourceStats) {
      await writeIsolatedHarnessFile(
        target,
        `${JSON.stringify(withOpenRouterModelRouting({}, pin), null, 2)}\n`,
      );
      return;
    }
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.nlink !== 1) {
      throw new AgentHomeSecurityError(
        `Pi custom model config is not an ordinary private source file: ${source}`,
      );
    }
    const resolvedSource = await realpath(source);
    if (resolvedSource !== source) {
      throw new AgentHomeSecurityError(`Pi custom model config resolves through a link: ${source}`);
    }
    const sourceValue = JSON.parse(readFileSync(resolvedSource, 'utf8')) as unknown;
    await writeIsolatedHarnessFile(
      target,
      `${JSON.stringify(withOpenRouterModelRouting(sourceValue, pin), null, 2)}\n`,
    );
  } catch (error) {
    // Never retain a stale credential-bearing copy when its current source is
    // unsafe or unreadable. A governed activation may choose to fail closed;
    // ordinary Rooms continue without the custom provider and log the cause.
    await unlink(target).catch(() => undefined);
    if (failClosed) throw error;
    console.warn('[body] operator Pi custom model passthrough failed:', error);
  }
}


export function readClaudeUserScopeMcpServers(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const servers = recordValue(parsed.mcpServers);
    if (servers) return localMcpServers(servers);
  } catch {
    // Malformed operator config: skip rather than fail the Room.
  }
  return undefined;
}


export function localHarnessMcpToml(source: string): string | undefined {
  let servers: Record<string, unknown> | undefined;
  try {
    servers = recordValue(parseToml(source).mcp_servers);
  } catch {
    return undefined;
  }
  if (!servers) return undefined;
  const hostNames = hostMcpServerNames(servers);
  const childTables = tomlChildTableNames(source, ['mcp_servers']);
  if (hostNames.every((name) => childTables.includes(name))) {
    return extractTomlSections(source, ['mcp_servers'], hostNames);
  }
  const bareLocal = Object.fromEntries(
    Object.entries(servers).filter(
      ([name]) => !childTables.includes(name) && !hostNames.includes(name),
    ),
  );
  const sections = [
    Object.keys(bareLocal).length > 0 ? stringifyToml({ mcp_servers: bareLocal }) : undefined,
    ...childTables
      .filter((name) => !hostNames.includes(name))
      .map((name) => extractTomlSections(source, ['mcp_servers', name])),
  ]
    .filter((section): section is string => section !== undefined)
    .map((section) => (section.endsWith('\n') ? section : `${section}\n`));
  return sections.length > 0 ? sections.join('\n') : undefined;
}


export function localGooseConfig(source: string): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    return source;
  }
  const document = recordValue(parsed);
  const extensions = recordValue(document?.extensions);
  if (!document || !extensions) return source;
  const local = localMcpServers(extensions);
  if (Object.keys(local).length === Object.keys(extensions).length) return source;
  return stringifyYaml({ ...document, extensions: local });
}


export function isHostMcpDeclaration(name: string, value: unknown): boolean {
  return classifyImportedMcpServer({ name, declaration: recordValue(value) ?? {} }) === 'host';
}


export function hostMcpServerNames(servers: Record<string, unknown>): string[] {
  return Object.entries(servers)
    .filter(([name, value]) => isHostMcpDeclaration(name, value))
    .map(([name]) => name);
}


export function localMcpServers(servers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).filter(([name, value]) => !isHostMcpDeclaration(name, value)),
  );
}


export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}


export function mountedImportedMcpServerNames(
  input: {
    operatorHome?: string;
    agentKind?: AgentKind;
    preparedEnv?: Record<string, string>;
  } = {},
): string[] {
  const names = new Set<string>();
  if (input.preparedEnv) {
    const env = input.preparedEnv;
    const home = env.HOME ?? input.operatorHome ?? homedir();
    for (const config of importedMcpConfigs(input.agentKind)) {
      const hasHome = config.format === 'extensions' ? Boolean(env[config.homeEnv]) : env[config.homeEnv] !== undefined;
      const path = hasHome
        ? resolve(env[config.homeEnv]!, config.file)
        : resolve(home, config.source);
      addMcpNamesFromMap(names, readImportedMcpServers(config.format, path));
    }
  } else {
    collectImportedMcpNames(input.operatorHome ?? homedir(), names, input.agentKind);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}


/**
 * Host-classified imported servers, read from the operator's own configs.
 * Ungranted ones stay out of the isolated home; granted ones are rewritten in
 * as routes. This is also the Room permission matcher's host-gated list,
 * minus live mcp grants.
 */
export function hostImportedMcpDeclarations(
  input: {
    operatorHome?: string;
    agentKind?: AgentKind;
  } = {},
): Record<string, Record<string, unknown>> {
  const operatorHome = input.operatorHome ?? homedir();
  const declarations: Record<string, Record<string, unknown>> = {};
  const add = (servers: Record<string, unknown> | undefined) => {
    if (!servers) return;
    for (const [name, value] of Object.entries(servers)) {
      if (isHostMcpDeclaration(name, value)) declarations[name] = recordValue(value) ?? {};
    }
  };
  for (const config of importedMcpConfigs(input.agentKind)) {
    add(readImportedMcpServers(config.format, resolve(operatorHome, config.source)));
  }
  return declarations;
}


export function hostImportedMcpServerNames(
  input: {
    operatorHome?: string;
    agentKind?: AgentKind;
  } = {},
): string[] {
  return Object.keys(hostImportedMcpDeclarations(input)).sort((left, right) =>
    left.localeCompare(right),
  );
}


/**
 * The host paths a session must have bound read-write: only the Squire broker
 * directory, and only for an agent whose grant actually rewrites a Squire
 * route. Any other `mcp` grant reaches none of it.
 */
export function grantedSquireHostBindPaths(input: {
  operatorHome?: string;
  agentKind?: AgentKind;
  grantedHostRoutes?: readonly string[];
}): string[] {
  const operatorHome = input.operatorHome ?? homedir();
  const granted = input.grantedHostRoutes ?? [];
  if (granted.length === 0) return [];
  return squireHostBindPaths(
    operatorHome,
    grantedSquireHostRoute(
      granted,
      hostImportedMcpDeclarations({ operatorHome, agentKind: input.agentKind }),
    ),
  );
}


/** Local copies plus granted host routes — the inventory prepare would write. */
export function expectedMountedImportedMcpServerNames(input: {
  operatorHome?: string;
  agentKind?: AgentKind;
  grantedHostRoutes?: readonly string[];
}): string[] {
  const local = mountedImportedMcpServerNames({
    operatorHome: input.operatorHome,
    agentKind: input.agentKind,
  });
  const allowed = new Set(input.grantedHostRoutes ?? []);
  const grantedHost = hostImportedMcpServerNames({
    operatorHome: input.operatorHome,
    agentKind: input.agentKind,
  }).filter((name) => allowed.has(name));
  // A code-owned host name is a standing route even when this harness has
  // no operator declaration to rewrite. The grant target is `squire`; the
  // operator file may use another key or be missing.
  for (const name of allowed) {
    if (isCodeOwnedHostMcpName(name)) grantedHost.push(name);
  }
  return [...new Set([...local, ...grantedHost])].sort((left, right) => left.localeCompare(right));
}


export function importedMcpConfigs(kind?: AgentKind) {
  const behaviors = kind ? [agentBehavior(kind)] : IMPORTED_MCP_KINDS.map(kind => AGENT_BEHAVIORS[kind]);
  return behaviors.flatMap((behavior) => behavior.importedMcp ? [behavior.importedMcp] : []);
}


export function readImportedMcpServers(format: 'toml' | 'json' | 'extensions', path: string): Record<string, unknown> | undefined {
  if (format === 'toml') return readTomlMcpServers(path);
  if (format === 'extensions') return readGooseExtensions(path);
  return recordValue(readJsonObject(path)?.mcpServers);
}


export function collectImportedMcpNames(operatorHome: string, names: Set<string>, kind?: AgentKind): void {
  for (const config of importedMcpConfigs(kind)) {
    addLocalMcpNames(names, readImportedMcpServers(config.format, resolve(operatorHome, config.source)));
  }
}


export function addLocalMcpNames(names: Set<string>, servers: Record<string, unknown> | undefined): void {
  if (!servers) return;
  for (const name of Object.keys(localMcpServers(servers))) names.add(name);
}


export function readTomlMcpServers(path: string): Record<string, unknown> | undefined {
  const source = readExistingText(path);
  if (source === undefined) return undefined;
  try {
    return recordValue(parseToml(source).mcp_servers);
  } catch {
    return undefined;
  }
}


export function readGooseExtensions(path: string): Record<string, unknown> | undefined {
  const source = readExistingText(path);
  if (source === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    return undefined;
  }
  return recordValue(recordValue(parsed)?.extensions);
}


export function addMcpNamesFromMap(
  names: Set<string>,
  servers: Record<string, unknown> | undefined,
): void {
  if (!servers) return;
  for (const name of Object.keys(servers)) names.add(name);
}


export function readExistingText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}


export function readJsonObject(path: string): Record<string, unknown> | undefined {
  const source = readExistingText(path);
  if (source === undefined) return undefined;
  try {
    const parsed = JSON.parse(source) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Atomically rebuild `target` with the exact release-owned defaults plus the
 * already-validated per-agent shares. No pre-existing destination entry is
 * followed or retained.
 */
export async function provisionManagedSkillsDir(
  target: string,
  managedSkills: Array<{ name: string; content: string }>,
  sharedSkills: Array<{ name: string; source: string }>,
  optionalShares: boolean,
): Promise<void> {
  const parent = dirname(target);
  await assertRealContainedDirectory(parent, dirname(parent));
  const plan = await planManagedSkills(managedSkills, sharedSkills, optionalShares);
  // The reuse test is content and file mode, on BOTH sides. The destination is agent-writable,
  // so its own existence, mtime or a receipt file it could have written are all
  // worthless as proof: the only evidence that matters is that every byte and
  // file mode matches this plan, and that nothing there is a
  // link or a shared inode a session could mutate underneath the harness.
  if ((await materializedSkillManifest(target)) === plan.manifest) return;
  const staged = resolve(parent, `.skills.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staged, { mode: 0o700 });
  try {
    for (const entry of plan.entries) {
      if (entry.kind === 'managed') {
        const skillDir = resolve(staged, entry.name);
        await mkdir(skillDir, { recursive: true });
        await writeIsolatedHarnessFile(resolve(skillDir, 'SKILL.md'), entry.content);
      } else {
        await copySafeSkillTree(entry.source, resolve(staged, entry.name), entry.source);
      }
    }
    const existing = await lstat(target).catch(() => undefined);
    if (existing) await rm(target, { recursive: existing.isDirectory(), force: true });
    await rename(staged, target);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}


export type PlannedSkill =
  | { kind: 'managed'; name: string; content: string }
  | { kind: 'shared'; name: string; source: string };
