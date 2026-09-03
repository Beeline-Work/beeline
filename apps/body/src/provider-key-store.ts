import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

/**
 * Per-operator provider API-key store for the connect wizard.
 *
 * One JSON file keyed by provider, mode 0600, so the wizard can offer a saved
 * key (or an environment key) as the default instead of re-asking every run.
 * Keys are never logged in full — `maskProviderKey` renders the short form
 * used in prompts.
 */
export type ProviderKeyProvider = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'xai';

export const PROVIDER_KEY_ENV_VARS: Record<ProviderKeyProvider, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  xai: 'XAI_API_KEY',
};

/** Alternate env var honored for Google (the runtime env historically used it). */
const GOOGLE_ENV_ALIAS = 'GEMINI_API_KEY';

export type ProviderKeyStore = Record<ProviderKeyProvider, string>;

export function providerKeyStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config');
  return resolve(configRoot, 'beeline', 'providers.json');
}

export async function readProviderKeyStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Partial<ProviderKeyStore>> {
  const path = providerKeyStorePath(env);
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [ProviderKeyProvider, string] =>
        entry[0] in PROVIDER_KEY_ENV_VARS && typeof entry[1] === 'string' && entry[1].length > 0,
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export async function readSavedProviderKey(
  provider: ProviderKeyProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  return (await readProviderKeyStore(env))[provider];
}

export async function saveProviderKey(
  provider: ProviderKeyProvider,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = providerKeyStorePath(env);
  const store = { ...(await readProviderKeyStore(env)), [provider]: key } as ProviderKeyStore;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function providerKeyFromEnvironment(
  provider: ProviderKeyProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const primary = env[PROVIDER_KEY_ENV_VARS[provider]]?.trim();
  if (primary) return primary;
  if (provider === 'google') return env[GOOGLE_ENV_ALIAS]?.trim() || undefined;
  return undefined;
}

/** Short, non-secret rendering: `sk-or-…b68` style. Never prints the full key. */
export function maskProviderKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 9) return '…';
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-3)}`;
}
