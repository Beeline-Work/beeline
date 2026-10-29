import { expect, it, vi } from 'vitest';
import { sharePersonInvite } from './share-person-invite';
it('retains the minted invite when browser sharing is absent', async () => {
  const fallback = vi.fn();
  await sharePersonInvite('https://example.test/join/existing', undefined, fallback);
  expect(fallback).toHaveBeenCalledWith('https://example.test/join/existing');
});
it('uses the available system share sheet', async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  const fallback = vi.fn();
  await sharePersonInvite('existing', share, fallback);
  expect(share).toHaveBeenCalledWith({ message: 'existing' });
  expect(fallback).not.toHaveBeenCalled();
});
it('retains the same link when sharing rejects', async () => {
  const fallback = vi.fn();
  await sharePersonInvite('existing', vi.fn().mockRejectedValue(new Error('unsupported')), fallback);
  expect(fallback).toHaveBeenCalledWith('existing');
});
