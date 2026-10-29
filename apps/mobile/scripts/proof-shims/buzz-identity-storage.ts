// Native proof stand-in: a signed-in viewer without a server session.
export * from '../../sources/auth/buzz-identity-storage';
export const loadBuzzIdentity = async () => ({ publicKey: 'human-proof' }) as never;
export const getEffectiveRelayUrl = async () => 'https://server.test';
