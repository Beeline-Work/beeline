import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

/**
 * The real Workbench and Wallet screens in the desktop web renderer. Tapping
 * a connected Wallet opens its page and drops no explainer under the row;
 * the Wallet page carries that explainer instead.
 */
describe('workbench tool tap in the desktop web renderer', () => {
  it('opens Wallet without an explainer drop-down and shows the explainer on the page', async () => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/tool-tap-proof-'));
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(
        entry,
        `import React from 'react'; import { createRoot } from 'react-dom/client';
        Promise.all([import('@/app/(app)/beeline/settings/workbench'), import('@/app/(app)/beeline/settings/workbench/wallet')])
          .then(([{ default: Workbench }, { default: Wallet }]) => run(Workbench, Wallet))
          .catch(error => { document.getElementById('result').textContent = 'load error: ' + (error?.stack ?? error); });
        function run(Workbench, Wallet) {
        globalThis.__server = { wallet: true, active: true, ops: [] };
        globalThis.__pushes = [];
        const has = id => !!document.querySelector('[data-testid="' + id + '"]');
        const text = id => document.querySelector('[data-testid="' + id + '"]')?.textContent ?? null;
        const output = {};
        const root = createRoot(document.getElementById('root'));
        root.render(<Workbench />);
        setTimeout(() => {
          output.row = text('workbench-connector-wallet');
          document.querySelector('[data-testid="workbench-connector-wallet-head"]').click();
          setTimeout(() => { output.detailsAfterTap = has('workbench-connector-wallet-details'); }, 0);
        }, 1200);
        setTimeout(() => {
          output.detailsLater = has('workbench-connector-wallet-details');
          output.pushes = globalThis.__pushes;
          root.render(<Wallet />);
        }, 1800);
        setTimeout(() => {
          output.explainer = text('wallet-explainer');
          document.getElementById('result').textContent = JSON.stringify(output);
        }, 3000);
        }`,
      );
      const shims = webProofShims(mobile);
      const result = await runBrowserProof({
        entry,
        mobile,
        width: 900,
        budgetMs: 5000,
        shims: {
          ...shims,
          '@expo/vector-icons': 'export const Ionicons = () => null;',
          'expo-web-browser': 'export const openAuthSessionAsync = async () => ({ type: "cancel" });',
          'expo-router': `import { useEffect } from 'react';
            export const useLocalSearchParams = () => ({ workspaceId: 'workspace-1', viewerId: 'viewer' });
            export const useFocusEffect = effect => useEffect(() => effect(), [effect]);
            export const router = { back() {}, replace() {}, push(href) { globalThis.__pushes.push(href.pathname); } };`,
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
      console.log('Workbench tool tap desktop web:', result.result);
      const proof = JSON.parse(result.result);
      expect(proof.row).toContain('connected');
      expect(proof.pushes).toEqual(['/beeline/settings/workbench/wallet']);
      expect(proof.detailsAfterTap).toBe(false);
      expect(proof.detailsLater).toBe(false);
      expect(proof.explainer).toContain("Coinbase's non-custodial wallet API");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90000);
});
