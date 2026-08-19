import { describe, expect, it, vi } from 'vitest';
import { loadIdentityFromNsec, identityNpub, identityNsec } from '@beeline/buzz-client';

const secureStore = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), remove: vi.fn() }));

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: secureStore.set,
  getItemAsync: secureStore.get,
  deleteItemAsync: secureStore.remove,
}));

const {
  canConfirmNewKeyBackup,
  canEnterWithNewKey,
  createNewKeyDraft,
  maskNsec,
} = await import('./new-key-onboarding');

describe('createNewKeyDraft', () => {
  it('generates a real, self-consistent nostr key', async () => {
    const draft = await createNewKeyDraft();

    expect(draft.nsec).toMatch(/^nsec1[0-9a-z]+$/);
    expect(draft.npub).toMatch(/^npub1[0-9a-z]+$/);
    // The displayed npub/nsec must describe the same identity the caller will
    // persist — not two independently derived strings.
    const reloaded = loadIdentityFromNsec(draft.nsec);
    expect(reloaded.publicKey).toBe(draft.identity.publicKey);
    expect(identityNpub(reloaded)).toBe(draft.npub);
    expect(identityNsec(draft.identity)).toBe(draft.nsec);
  });

  it('never writes the key to device storage', async () => {
    secureStore.set.mockClear();
    await createNewKeyDraft();
    // The whole point of the backup gate: an abandoned draft leaves nothing
    // behind, so a person can never end up holding an unbacked identity.
    expect(secureStore.set).not.toHaveBeenCalled();
  });

  it('generates a distinct key every time', async () => {
    const [a, b] = await Promise.all([createNewKeyDraft(), createNewKeyDraft()]);
    expect(a.identity.publicKey).not.toBe(b.identity.publicKey);
  });
});

describe('maskNsec', () => {
  it('shows only the nsec1 prefix', async () => {
    const draft = await createNewKeyDraft();
    const masked = maskNsec(draft.nsec);
    expect(masked.startsWith('nsec1')).toBe(true);
    expect(masked).not.toContain(draft.nsec.slice(5));
    // A fixed dot run — the real length is not a hint worth leaking.
    expect(masked).toBe(`nsec1${'•'.repeat(32)}`);
  });

  it('returns an empty string for an empty secret', () => {
    expect(maskNsec('')).toBe('');
  });
});

describe('the backup gate', () => {
  it('keeps the acknowledgement inert until the key was revealed or copied', () => {
    expect(canConfirmNewKeyBackup({ seen: false })).toBe(false);
    expect(canConfirmNewKeyBackup({ seen: true })).toBe(true);
  });

  it('refuses entry until the key was both seen and acknowledged', () => {
    expect(canEnterWithNewKey({ seen: false, confirmed: false })).toBe(false);
    expect(canEnterWithNewKey({ seen: true, confirmed: false })).toBe(false);
    // A confirmation over a still-masked key confirms nothing.
    expect(canEnterWithNewKey({ seen: false, confirmed: true })).toBe(false);
    expect(canEnterWithNewKey({ seen: true, confirmed: true })).toBe(true);
  });
});
