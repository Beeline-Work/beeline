import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_INSTITUTIONAL_CONTEXT,
  institutionalContextForTurn,
} from './institutional-context.js';

describe('institutional context fetch', () => {
  it('returns the frozen server snapshot', async () => {
    const snapshot = {
      snapshotRevision: 7,
      text: 'quoted memory',
      itemIds: ['item-1'],
      totalBytes: 13,
      omitted: {},
    };
    const execute = vi.fn().mockResolvedValue(snapshot);
    await expect(
      institutionalContextForTurn({ execute } as never, 'room-1', vi.fn(), 200, true),
    ).resolves.toEqual(snapshot);
    expect(execute).toHaveBeenCalledWith('getInstitutionalContext', { roomId: 'room-1' });
  });

  it('degrades query failures and timeouts to an empty block', async () => {
    const failures: string[] = [];
    await expect(
      institutionalContextForTurn(
        { execute: vi.fn().mockRejectedValue(new Error('database unavailable')) } as never,
        'room-1',
        (message) => failures.push(message),
        200,
        true,
      ),
    ).resolves.toEqual(EMPTY_INSTITUTIONAL_CONTEXT);
    await expect(
      institutionalContextForTurn(
        { execute: vi.fn(() => new Promise(() => undefined)) } as never,
        'room-1',
        (message) => failures.push(message),
        1,
        true,
      ),
    ).resolves.toEqual(EMPTY_INSTITUTIONAL_CONTEXT);
    expect(failures).toEqual([
      'institutional context unavailable: database unavailable',
      'institutional context unavailable: institutional context timed out',
    ]);
  });

  it('is dark without the live host flag', async () => {
    const execute = vi.fn();
    await expect(institutionalContextForTurn({ execute } as never, 'room-1')).resolves.toEqual(
      EMPTY_INSTITUTIONAL_CONTEXT,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
