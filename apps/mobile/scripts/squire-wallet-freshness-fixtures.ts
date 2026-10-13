import { mockSurfaceStorage } from '../sources/test/mock-surface-storage';
const cache = mockSurfaceStorage();
export const mobileSurfaceCache = cache.mobileSurfaceCache;
export const surfaceAddress = cache.surfaceAddress;
const wallet = (totalUsd: string) => ({ address: '0x1234567890123456789012345678901234567890', solanaAddress: null,
  totalUsd, coins: [{ symbol: 'USDC', name: 'USD Coin', amount: totalUsd.slice(1), usd: totalUsd, chain: 'base' }],
  chains: [], sponsorship: { usedUsd: '$0', limitUsd: '$5' }, delegation: { active: true, expiresAt: null } });
const detail = (fresh: boolean) => ({ connection: { connectionId: 'key', ref: 'key', name: 'Deployment key',
  service: 'vercel', ownerId: 'owner', hosts: ['api.vercel.com'], fieldNames: ['token'], state: 'active',
  grantCount: fresh ? 0 : 1 }, grants: fresh ? [] : [{ grantId: 'agent', createdAt: 1 }],
  ledger: fresh ? [{ at: '14:00', actor: '@bee', action: 'deploy', status: '200' }] : [], spendCap: 'none' });
const workbench = { apps: [], connectors: [], connections: [], helpers: [{ id: 'machine-one', name: 'Laptop', online: true,
  squire: { status: 'connected', reportedAt: 1 } }] };
const seed = (endpoint: string, params: Record<string, unknown>, value: unknown) =>
  mobileSurfaceCache.publish(surfaceAddress('', '', endpoint, params), value);
seed('/workspace/:id/wallet', { workspaceId: 'ws' }, wallet('$100'));
seed('/workspace/:id/wallet-history', { workspaceId: 'ws' }, { entries: [] });
seed('/workspace/:id/connections/:connectionId', { workspaceId: 'ws', viewerId: 'owner', connectionId: 'key' }, detail(false));
seed('/workspace/:id/workbench', { workspaceId: 'ws', viewerId: 'owner' }, workbench);
export const getWalletSource = () => ({ readWallet: async () => wallet('$60'), readHistory: async () => ({ entries: [
  { id: 'debit', kind: 'send', chain: 'base', asset: 'USDC', amount: '40', amountUsd: '$40',
    direction: 'debit', status: 'sent', createdAt: Date.now()/1000, label: 'Agent purchase', amountText: '-40 USDC', at: '14:00' },
] }) });
export const getWorkbenchSource = () => ({ readWorkbench: async () => workbench,
  readConnectionDetail: async () => detail(true), disconnectConnector: async () => {} });
