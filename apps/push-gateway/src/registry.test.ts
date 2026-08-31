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
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2);
  });

  it('persists only the latest running-update receipt for each identity device', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buzzy-push-receipts-'));
    const file = join(directory, 'registrations.json');
    const registry = await TokenRegistry.load(file);
    const receipt = {
      pubkey: PUBKEY_A,
      deviceId: '11111111-2222-3333-4444-555555555555',
      updateId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      channel: 'production',
      group: '99999999-8888-7777-6666-555555555555',
      runtimeVersion: '21',
      releaseVersion: 'v0.0.1',
      sourceSha: '1'.repeat(40),
      environment: 'physical' as const,
    };

    await registry.recordUpdateReceipt(receipt, new Date('2026-08-29T20:00:00.000Z'));
    await registry.recordUpdateReceipt(
      { ...receipt, updateId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' },
      new Date('2026-08-29T20:05:00.000Z'),
    );

    const reloaded = await TokenRegistry.load(file);
    expect(reloaded.receiptsForPubkey(PUBKEY_A)).toEqual([
      expect.objectContaining({
        updateId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        reportedAt: '2026-08-29T20:05:00.000Z',
      }),
    ]);
  });

  it('rejects malformed pubkeys and tokens', async () => {
    const registry = await TokenRegistry.load();
    await expect(registry.register('not-a-pubkey', TOKEN_A)).rejects.toThrow('invalid pubkey');
    await expect(registry.register(PUBKEY_A, 'tiny')).rejects.toThrow('invalid FCM token');
  });
});
