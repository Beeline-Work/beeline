// Wires a joined app to Beeline without manual edits. Every change is additive (other entries stay), backed up once,
// and removed again by `usebeeline session leave`. Ported from Reason Network (src/setup.rs, src/setup/*.rs),
// Copyright 2026 Reason Machines, Inc., MIT OR Apache-2.0. See ./NOTICE and ./UPSTREAM.json for the copied commit.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentId } from './agents.js';
import { claudeConfigDir } from './claude.js';
import { codexHome } from './codex.js';
import { HERMES_MANIFEST, HERMES_PLUGIN, OPENCODE_PLUGIN, PI_EXTENSION, fill } from './templates.js';

export const NAME = 'beeline';
type Json = Record<string, unknown>;

export interface SetupContext {
  env: NodeJS.ProcessEnv;
  /** The node binary and the stable copy of this bundle that hooks and plugins run. */
  node: string;
  bundle: string;
  remove?: boolean;
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}

export function readJson(path: string): Json {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!text.trim()) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a JSON object; not touching it`);
  return value as Json;
}

function object(parent: Json, key: string): Json {
  const value = parent[key];
  if (value === undefined) return (parent[key] = {}) as Json;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`"${key}" is not a JSON object; not touching it`);
  return value as Json;
}

/** Writes `content` if it differs, backing up an original once. Returns whether anything changed. */
export function writeFile(path: string, content: string, expected?: { text: string | undefined }): boolean {
  let before: string | undefined;
  try { before = readFileSync(path, 'utf8'); } catch { /* new file */ }
  if (before === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  const backup = `${path}.bak-${NAME}`;
  if (before !== undefined && !existsSync(backup) && !before.includes(' session hook ')) copyFileSync(path, backup);
  const temp = `${path}.${process.pid}.tmp-${NAME}`;
  writeFileSync(temp, content);
  // Keep its permissions: a config holding tokens may be 0600.
  try { chmodSync(temp, statSync(path).mode & 0o777); } catch { /* new file */ }
  if (expected) {
    let latest: string | undefined;
    try { latest = readFileSync(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { rmSync(temp, { force: true }); throw error; }
    }
    if (latest !== expected.text) { rmSync(temp, { force: true }); throw new ConfigChanged(); }
  }
  renameSync(temp, path);
  return true;
}

class ConfigChanged extends Error {}

/** Re-merge when Claude rewrites its user config while Beeline prepares the replacement. */
function mergeClaudeMcp(path: string, context: SetupContext): string[] {
  for (let attempt = 0; attempt < 5; attempt++) {
    let before: string | undefined;
    try { before = readFileSync(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const value = readJson(path);
    const servers = object(value, 'mcpServers');
    if (context.remove) delete servers[NAME];
    else servers[NAME] = { type: 'stdio', command: context.node, args: [context.bundle, 'session', 'claude-mcp'] };
    if (!Object.keys(servers).length) delete value.mcpServers;
    try {
      const changed = writeFile(path, JSON.stringify(value, null, 2) + '\n', { text: before });
      return changed ? [`${context.remove ? 'removed Beeline from' : 'updated'} ${path}`] : [];
    } catch (error) { if (!(error instanceof ConfigChanged)) throw error; }
  }
  throw new Error('Claude Code kept changing its user config; retry joining when it is idle.');
}

function writeJson(path: string, value: Json): boolean {
  return writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function hookCommand(context: SetupContext, agent: AgentId, event: string): string {
  return `${quote(context.node)} ${quote(context.bundle)} session hook ${agent} ${event}`;
}

/**
 * Hook groups in the Claude Code style (`{matcher, hooks: [{type, command}]}`), used by Claude Code, Codex and Gemini.
 * Replaces our earlier groups for `agent` and keeps everything else, including other handlers in a shared group.
 */
export function mergeHookGroups(hooks: Json, agent: AgentId, groups: [string, Json][], remove: boolean): void {
  const marker = ` session hook ${agent} `;
  const mine = (value: unknown) => JSON.stringify(value).includes(marker);
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const group of list) {
      const inner = (group as Json | null)?.hooks;
      if (Array.isArray(inner)) (group as Json).hooks = inner.filter(handler => !mine(handler));
    }
    const kept = list.filter(group => {
      const inner = (group as Json | null)?.hooks;
      return Array.isArray(inner) ? inner.length > 0 : !mine(group);
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (remove) return;
  for (const [event, group] of groups) {
    const list = hooks[event];
    hooks[event] = Array.isArray(list) ? [...list, group] : [group];
  }
}

function hooksFile(path: string, agent: AgentId, groups: [string, Json][], remove: boolean, nested = true): string[] {
  const value = readJson(path);
  mergeHookGroups(nested ? object(value, 'hooks') : value, agent, groups, remove);
  if (nested && !Object.keys(value.hooks as Json).length) delete value.hooks;
  return saveJson(path, value, remove);
}

/** Writes a config; on removal, a file only Beeline wrote goes away with its entry. */
function saveJson(path: string, value: Json, remove: boolean): string[] {
  if (remove && !Object.keys(value).length && !existsSync(`${path}.bak-${NAME}`)) {
    if (!existsSync(path)) return [];
    rmSync(path, { force: true });
    return [`removed ${path}`];
  }
  return writeJson(path, value) ? [`${remove ? 'removed Beeline from' : 'updated'} ${path}`] : [];
}

function claudeCode(context: SetupContext): string[] {
  const command = (event: string) => ({ hooks: [{ type: 'command', command: hookCommand(context, 'claude-code', event), timeout: 10 }] });
  const remove = Boolean(context.remove);
  const path = context.env.CLAUDE_CONFIG_DIR ? join(context.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home(context.env), '.claude.json');
  return [...mergeClaudeMcp(path, context), ...hooksFile(join(claudeConfigDir(context.env), 'settings.json'), 'claude-code', [['SessionStart', command('session-start')]], remove)];
}

function codex(context: SetupContext): string[] {
  const group = (event: string) => ({ matcher: '*', hooks: [{ type: 'command', command: hookCommand(context, 'codex', event), timeout: 10 }] });
  const lines = hooksFile(join(codexHome(context.env), 'hooks.json'), 'codex', [['SessionStart', group('session-start')]], Boolean(context.remove));
  if (lines.length && !context.remove) lines.push('Codex asks once to trust Beeline’s SessionStart hook if automatic trust is unavailable: open /hooks and trust only Beeline.');
  return lines;
}

export function geminiHome(env: NodeJS.ProcessEnv): string {
  return env.GEMINI_CLI_HOME || join(home(env), '.gemini');
}

function gemini(context: SetupContext): string[] {
  const group = (event: string, timeout: number) => ({ matcher: '*', hooks: [{ type: 'command', name: `${NAME}-${event}`,
    command: hookCommand(context, 'gemini', event), timeout }] });
  return hooksFile(join(geminiHome(context.env), 'settings.json'), 'gemini', [
    ['SessionStart', group('session-start', 10_000)], ['BeforeAgent', group('user-prompt-submit', 10_000)],
    ['AfterTool', group('post-tool-use', 10_000)], ['AfterAgent', group('stop', 10_000)], ['SessionEnd', group('session-end', 5_000)],
  ], Boolean(context.remove));
}

/** Antigravity: native hooks deliver at invocation and Stop; its sidecar hands messages to idle App conversations. */
function antigravity(context: SetupContext): string[] {
  const dir = join(home(context.env), '.gemini/config');
  const lines: string[] = [];
  const hooksPath = join(dir, 'hooks.json');
  const hooks = readJson(hooksPath);
  if (context.remove) delete hooks[NAME];
  else {
    const handler = (event: string) => ({ type: 'command', command: hookCommand(context, 'antigravity', event), timeout: 15 });
    const enabled = (hooks[NAME] as Json | undefined)?.enabled ?? true;
    hooks[NAME] = { enabled, SessionStart: [handler('session-start')], PreInvocation: [handler('user-prompt-submit')],
      PostToolUse: [{ matcher: '*', hooks: [handler('post-tool-use')] }], Stop: [handler('stop')] };
  }
  lines.push(...saveJson(hooksPath, hooks, Boolean(context.remove)));
  const sidecar = join(dir, 'sidecars', NAME, 'sidecar.json');
  const configPath = join(dir, 'config.json');
  const config = readJson(configPath);
  const sidecars = object(config, 'sidecars');
  if (context.remove) {
    delete sidecars[NAME];
    rmSync(dirname(sidecar), { recursive: true, force: true });
  } else {
    if (writeJson(sidecar, { command: context.node, args: [context.bundle, 'session', 'antigravity-sidecar'], restart_policy: 'on-failure',
      display_name: 'Beeline', description: 'Deliver Beeline Room tags to your joined conversations' })) lines.push(`updated ${sidecar}`);
    // Keep an explicit choice to disable it.
    sidecars[NAME] ??= { enabled: true };
  }
  if (!Object.keys(sidecars).length) delete config.sidecars;
  lines.push(...saveJson(configPath, config, Boolean(context.remove)));
  return lines;
}

function pluginFile(path: string, content: string, remove: boolean): string[] {
  if (remove) {
    if (!existsSync(path)) return [];
    rmSync(path, { force: true });
    return [`removed ${path}`];
  }
  return writeFile(path, content) ? [`updated ${path}`] : [];
}

function opencode(context: SetupContext): string[] {
  return pluginFile(join(home(context.env), '.config/opencode/plugins', `${NAME}.ts`), fill(OPENCODE_PLUGIN, context.node, context.bundle), Boolean(context.remove));
}

export function piHome(env: NodeJS.ProcessEnv): string {
  return env.PI_CODING_AGENT_DIR || join(home(env), '.pi/agent');
}

function pi(context: SetupContext): string[] {
  return pluginFile(join(piHome(context.env), 'extensions', `${NAME}.ts`), fill(PI_EXTENSION, context.node, context.bundle), Boolean(context.remove));
}

/** The active Hermes profile's home. */
export function hermesRoot(env: NodeJS.ProcessEnv): string {
  const base = env.HERMES_HOME ? env.HERMES_HOME.replace(/^~(?=\/|$)/, home(env)) : join(home(env), `.hermes${env.HERMES_DATA_DIR_SUFFIX ?? ''}`);
  let active = '';
  try { active = readFileSync(join(base, 'active_profile'), 'utf8').trim(); } catch { /* default */ }
  if (active && active !== 'default' && active !== '.' && active !== '..' && !/[/\\]/.test(active) && existsSync(join(base, 'profiles', active)))
    return join(base, 'profiles', active);
  return base;
}

function hermes(context: SetupContext): string[] {
  const dir = join(hermesRoot(context.env), 'plugins', NAME);
  const remove = Boolean(context.remove);
  const lines = [...pluginFile(join(dir, '__init__.py'), fill(HERMES_PLUGIN, context.node, context.bundle), remove),
    ...pluginFile(join(dir, 'plugin.yaml'), HERMES_MANIFEST, remove)];
  if (remove) rmSync(dir, { recursive: true, force: true });
  // Hermes loads only plugins its person enabled: enable ours, so no manual step remains.
  const done = spawnSync('hermes', ['plugins', remove ? 'disable' : 'enable', NAME], { env: context.env, stdio: 'ignore', timeout: 15_000 });
  if (!remove && done.status !== 0) lines.push(`Run "hermes plugins enable ${NAME}" once if Hermes does not load it.`);
  return lines;
}

/**
 * ZCode reads user MCP servers from `~/.zcode/cli/config.json` (`mcp.servers`); while that has none, it reads
 * `~/.agents/mcp.json` (`mcpServers`), so a server added to the first would hide every server in the second.
 */
export function zcodeIn(homeDir: string, context: SetupContext): string[] {
  const native = join(homeDir, '.zcode/cli/config.json'), fallback = join(homeDir, '.agents/mcp.json');
  const servers = (value: Json, isNative: boolean) => isNative ? object(object(value, 'mcp'), 'servers') : object(value, 'mcpServers');
  const remove = Boolean(context.remove);
  const toFallback = !remove && !Object.keys(servers(readJson(native), true)).some(key => key !== NAME)
    && Object.keys(servers(readJson(fallback), false)).length > 0;
  const targets: [string, boolean][] = remove ? [[native, true], [fallback, false]] : toFallback ? [[fallback, false], [native, true]] : [[native, true]];
  const lines: string[] = [];
  for (const [path, isNative] of targets) {
    if (!existsSync(path) && (remove || (isNative && toFallback))) continue;
    const value = readJson(path);
    const list = servers(value, isNative);
    if (remove || (isNative && toFallback)) {
      if (!(NAME in list)) continue;
      delete list[NAME];
    } else list[NAME] = { type: 'stdio', command: context.node, args: [context.bundle, 'session', 'mcp'], env: { BEELINE_SESSION_AGENT: 'zcode' } };
    if (writeJson(path, value)) lines.push(`updated ${path}`);
  }
  return lines;
}

const SETUP: Record<AgentId, (context: SetupContext) => string[]> = {
  'claude-code': claudeCode, codex, gemini, antigravity, opencode, pi, hermes,
  zcode: context => zcodeIn(home(context.env), context),
};

/** Wires (or with `remove`, unwires) one app. Returns what changed, for the person to see. */
export function setupAgent(agent: AgentId, context: SetupContext): string[] {
  return SETUP[agent](context);
}
