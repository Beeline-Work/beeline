import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { claudeConfigDir } from './claude.js';
import { readJson, writeFile } from './setup.js';
import { readState, stateDir, withLock } from './store.js';

/** A managed hold is an administrator's decision; joining must not change any app config. */
export function assertClaudePolicy(env: NodeJS.ProcessEnv): void {
  const paths = [env.CLAUDE_CODE_MANAGED_SETTINGS_PATH, join(claudeConfigDir(env), 'managed-settings.json'),
    process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json'];
  for (const path of paths) {
    if (!path) continue;
    const setting = readJson(path).crossSessionInbound;
    if (setting === 'hold' || setting === 'refuse') throw new Error(`Claude Code managed policy sets crossSessionInbound to ${setting}. Beeline wrote no app settings. Ask your administrator to allow messages.`);
  }
}

/** Called only after Allow, and only for a bypass session without its in-session server. */
export async function acceptClaudeInbound(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = stateDir(env);
  await withLock(dir, () => {
    assertClaudePolicy(env);
    const path = join(claudeConfigDir(env), 'settings.json');
    const saved = join(dir, 'claude-inbound.json');
    const value = readJson(path);
    if (!existsSync(saved)) writeFile(saved, JSON.stringify({ present: Object.hasOwn(value, 'crossSessionInbound'), value: value.crossSessionInbound }));
    // Re-read immediately before the atomic replacement, keeping unrelated concurrent app changes.
    const current = readJson(path);
    current.crossSessionInbound = 'accept';
    writeFile(path, JSON.stringify(current, null, 2) + '\n');
  });
}

export async function restoreClaudeInbound(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = stateDir(env);
  await withLock(dir, () => {
    if (readState(dir).sessions.length) return;
    const saved = join(dir, 'claude-inbound.json');
    if (!existsSync(saved)) return;
    assertClaudePolicy(env);
    const old = JSON.parse(readFileSync(saved, 'utf8')) as { present: boolean; value?: unknown };
    const path = join(claudeConfigDir(env), 'settings.json');
    const value = readJson(path);
    // A person's later choice takes precedence over Beeline's temporary value.
    if (value.crossSessionInbound === 'accept') {
      if (old.present) value.crossSessionInbound = old.value;
      else delete value.crossSessionInbound;
      writeFile(path, JSON.stringify(value, null, 2) + '\n');
    }
    rmSync(saved);
  });
}
