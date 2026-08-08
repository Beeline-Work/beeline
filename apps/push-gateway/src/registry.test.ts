import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenRegistry } from './registry.js';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const TOKEN_A = 'fcm-token-A_12345678901234567890';
const TOKEN_B = 'fcm-token-B_12345678901234567890';

describe('TokenRegistry', () => {
  it('registers and deduplicates tokens by pubkey', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    await registry.register(PUBKEY_A, TOKEN_A);
    await registry.register(PUBKEY_A, TOKEN_B);

    expect(registry.pubkeyCount).toBe(1);
    expect(registry.tokenCount).toBe(2);
    expect(registry.tokensForPubkeys([PUBKEY_A])).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('moves a device token when a different identity registers it', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    await registry.register(PUBKEY_B, TOKEN_A);

    expect(registry.tokensForPubkeys([PUBKEY_A])).toEqual([]);
    expect(registry.tokensForPubkeys([PUBKEY_B])).toEqual([TOKEN_A]);
  });

  it('persists and reloads registrations without exposing them through metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buzzy-push-registry-'));
    const file = join(directory, 'registrations.json');
    const registry = await TokenRegistry.load(file);
    await registry.register(PUBKEY_A, TOKEN_A);

    const reloaded = await TokenRegistry.load(file);
    expect(reloaded.tokensForPubkeys([PUBKEY_A])).toEqual([TOKEN_A]);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
  });

  it('rejects malformed pubkeys and tokens', async () => {
    const registry = await TokenRegistry.load();
    await expect(registry.register('not-a-pubkey', TOKEN_A)).rejects.toThrow('invalid pubkey');
    await expect(registry.register(PUBKEY_A, 'tiny')).rejects.toThrow('invalid FCM token');
  });
});
