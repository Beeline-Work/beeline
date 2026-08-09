import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorage,
}));

import {
  dismissKeyBackupNudge,
  isKeyBackupNudgeDismissed,
} from './key-backup-nudge';

describe('key backup nudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asyncStorage.getItem.mockResolvedValue(null);
    asyncStorage.setItem.mockResolvedValue(undefined);
  });

  it('is visible until dismissed for the current identity', async () => {
    await expect(isKeyBackupNudgeDismissed('pubkey-a')).resolves.toBe(false);
    expect(asyncStorage.getItem).toHaveBeenCalledWith(
      '@buzzy/identity/backup-nudge-dismissed/pubkey-a',
    );
  });

  it('stores dismissal independently per identity', async () => {
    await dismissKeyBackupNudge('pubkey-a');
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      '@buzzy/identity/backup-nudge-dismissed/pubkey-a',
      'true',
    );
  });
});
