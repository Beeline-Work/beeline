import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

/**
 * The real Workbench and Wallet screens in the desktop web renderer, over the
 * real Workbench and Wallet sources and a fake server that keeps the wallet
 * binding and its grant to sign. A wallet that exists without an active grant
 * is not connected; pressing Connect is the grant.
 */
describe('wallet connect in the desktop web renderer', () => {
  it('shows Wallet unconnected until Connect grants agents permission to sign', async () => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/wallet-proof-'));
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(
        entry,
        `import React from 'react'; import { createRoot } from 'react-dom/client';
        Promise.all([import('@/app/(app)/beeline/settings/workbench'), import('@/app/(app)/beeline/settings/workbench/wallet')])
          .then(([{ default: Workbench }, { default: Wallet }]) => run(Workbench, Wallet))
          .catch(error => { document.getElementById('result').textContent = 'load error: ' + (error?.stack ?? error); });
        function run(Workbench, Wallet) {
        // A wallet binding that was created earlier but never granted.
        globalThis.__server = { wallet: true, active: false, ops: [] };
        const text = id => document.querySelector('[data-testid="' + id + '"]')?.textContent ?? null;
        const output = {};
        const first = createRoot(document.getElementById('root'));
        first.render(<><Workbench /><Wallet /></>);
        setTimeout(() => {
          output.rowBefore = text('workbench-connector-wallet');
          output.pageBefore = text('wallet-screen');
          output.addressBefore = !!document.querySelector('[data-testid="wallet-address"]');
          document.querySelector('[data-testid="workbench-connector-wallet-connect"]').click();
        }, 1200);
        setTimeout(() => {
          output.ops = globalThis.__server.ops;
          first.unmount();
          createRoot(document.getElementById('root')).render(<><Workbench /><Wallet /></>);
        }, 2400);
        setTimeout(() => {
          output.rowAfter = text('workbench-connector-wallet');
          output.addressAfter = !!document.querySelector('[data-testid="wallet-address"]');
          output.connectRowAfter = !!document.querySelector('[data-testid="wallet-connect-row"]');
          document.getElementById('result').textContent = JSON.stringify(output);
        }, 3600);
        }`,
      );
      const shims = webProofShims(mobile);
      const result = await runBrowserProof({
        entry,
        mobile,
        width: 900,
        budgetMs: 6000,
        shims: {
          ...shims,
          '@expo/vector-icons': 'export const Ionicons = () => null;',
          'expo-web-browser': 'export const openAuthSessionAsync = async () => ({ type: "cancel" });',
          'expo-router': `import { useEffect } from 'react';
            export const useLocalSearchParams = () => ({ workspaceId: 'workspace-1', viewerId: 'viewer' });
            export const useFocusEffect = effect => useEffect(() => effect(), [effect]);
            export const router = { back() {}, replace() {}, push() {} };`,
          '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithUrl: "https://monolith.test" });',
          '@/auth/auth-session': 'export const authSessionOptions = () => ({});',
          '@/buzz/wallet-workspace': 'export const resolveWalletWorkspaceId = async id => id || "workspace-1";',
          '@/sync/transport/monolith-operation': `const wallet = () => ({ address: '0xabc', solanaAddress: null, totalUsd: '$0.00', coins: [], chains: [], sponsorship: null,
              delegation: { active: globalThis.__server.active, expiresAt: null } });
            export class MonolithPhoneOperationError extends Error {}
            export const phoneOperationFailureReason = error => String(error?.message ?? error);
            export const monolithPhoneOperation = async (operation) => {
              const server = globalThis.__server;
              if (operation === 'readWorkbench') return { workspaceId: 'workspace-1', helpers: [], connectors: [], connections: [], apps: [],
                catalog: [{ connectorType: 'wallet', name: 'Wallet', available: true }],
                ...(server.wallet ? { wallet: { createdAt: 1, delegationActive: server.active, delegationExpiresAt: null } } : {}) };
              if (operation === 'createWallet') { server.ops.push(operation); server.wallet = true; return wallet(); }
              if (operation === 'grantWalletDelegation') { server.ops.push(operation); server.active = true; return { expiresAt: null }; }
              if (operation === 'readWallet') return wallet();
              if (operation === 'readWalletHistory') return { entries: [] };
              return {};
            };`,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      console.log('Wallet connect desktop web:', result.result);
      const proof = JSON.parse(result.result);
      expect(proof.rowBefore).toContain('Connect');
      expect(proof.rowBefore).not.toContain('connected');
      expect(proof.pageBefore).toContain('Wallet not connected');
      expect(proof.addressBefore).toBe(false);
      expect(proof.ops).toEqual(['createWallet', 'grantWalletDelegation']);
      expect(proof.rowAfter).toContain('connected');
      expect(proof.addressAfter).toBe(true);
      expect(proof.connectRowAfter).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90000);
});
