import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  maskProviderKey,
  providerKeyFromEnvironment,
  providerKeyStorePath,
  readProviderKeyStore,
  readSavedProviderKey,
  saveProviderKey,
} from './provider-key-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envFor(root: string): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: root, HOME: root };
}

describe('provider key store', () => {
  it('stores and recalls provider keys with mode 0600', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-keys-'));
    roots.push(root);
    const env = envFor(root);

    await expect(readSavedProviderKey('openrouter', env)).resolves.toBeUndefined();
    await saveProviderKey('openrouter', 'sk-or-v1-abcdef1234567890', env);
    const path = providerKeyStorePath(env);
    expect(path).toBe(join(root, 'beeline', 'providers.json'));
    await expect(readSavedProviderKey('openrouter', env)).resolves.toBe(
      'sk-or-v1-abcdef1234567890',
    );
    const { stat } = await import('node:fs/promises');
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // Saving another provider preserves the first; replacing overwrites.
    await saveProviderKey('anthropic', 'sk-ant-zzz', env);
    await saveProviderKey('openrouter', 'sk-or-v1-replaced', env);
    await expect(readProviderKeyStore(env)).resolves.toEqual({
      openrouter: 'sk-or-v1-replaced',
      anthropic: 'sk-ant-zzz',
    });
  });

  it('honors provider keys from the environment as defaults', async () => {
    expect(
      providerKeyFromEnvironment('openrouter', { OPENROUTER_API_KEY: ' env-key ' }),
    ).toBe('env-key');
    expect(providerKeyFromEnvironment('google', { GEMINI_API_KEY: 'gem' })).toBe('gem');
    expect(providerKeyFromEnvironment('google', { GOOGLE_API_KEY: 'goo', GEMINI_API_KEY: 'gem' })).toBe(
      'goo',
    );
    expect(providerKeyFromEnvironment('openai', {})).toBeUndefined();
  });

  it('tolerates a missing or corrupt store file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-keys-'));
    roots.push(root);
    const env = envFor(root);
    await mkdir(join(root, 'beeline'), { recursive: true });
    const path = providerKeyStorePath(env);
    await writeFile(path, 'not json\n');
    await chmod(path, 0o600);
    await expect(readProviderKeyStore(env)).resolves.toEqual({});
    await expect(readSavedProviderKey('xai', env)).resolves.toBeUndefined();
  });

  it('never renders the full key in prompts', () => {
    expect(maskProviderKey('sk-or-v1-abcdefghijklmn123')).toBe('sk-or-…123');
    expect(maskProviderKey('short')).toBe('…');
    expect(maskProviderKey('sk-or-v1-abcdefghijklmn123')).not.toContain('abcdefghijklmn');
  });
});
