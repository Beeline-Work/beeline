import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

describe('Reproduction squire-machine-status-2 in Connectors', () => {
  it.each([390, 900])('renders one sign-in service and its machine broker reports at %spx', async (width) => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/squire-status-proof-'));
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
        import Workbench from '@/app/(app)/beeline/settings/workbench';
        import Service from '@/app/(app)/beeline/settings/workbench/service';
        globalThis.__params = { workspaceId: 'workspace', viewerId: 'owner' };
        const root = createRoot(document.getElementById('root'));
        root.render(<Workbench />);
        const output = {};
        setTimeout(() => {
          output.page = document.querySelector('[data-testid="connectors-attention"]')?.textContent;
          globalThis.__params = { workspaceId: 'workspace', viewerId: 'owner',
            service: 'trusty-squire', helperId: 'failed' };
          root.render(<Service />);
        }, 1400);
        setTimeout(() => {
          output.service = document.querySelector('[data-testid="connector-service-screen"]')?.textContent;
          document.querySelector('[data-testid="squire-computer-failed"]').click();
        }, 2600);
        setTimeout(() => {
          // An online computer that can retry reconnects in one tap, with no sheet first.
          output.sheet = document.body.textContent;
          output.destination = globalThis.__push;
          document.getElementById('result').textContent = JSON.stringify(output);
        }, 3100);`);
      const result = await runBrowserProof({ entry, mobile, width, budgetMs: 4000,
        shims: {
          ...webProofShims(mobile),
          '@expo/vector-icons': 'export const Ionicons = () => null;',
          'expo-router': `import { useEffect } from 'react';
            export const useLocalSearchParams = () => globalThis.__params;
            export const useFocusEffect = effect => useEffect(() => effect(), [effect]);
            export const router = { back() {}, push(route) { globalThis.__push = route; }, replace() {} };`,
          '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithUrl: "https://monolith.test" });',
          '@/auth/auth-session': 'export const authSessionOptions = () => ({});',
          '@/buzz/wallet-workspace': 'export const resolveWalletWorkspaceId = async () => "workspace";',
          '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => ({ publicKey: 'owner' });
            export const getEffectiveRelayUrl = async () => 'https://monolith.test';`,
          '@/sync/transport/live-connection': 'export const sharedLiveConnection = () => ({ register: async () => () => {} });',
          '@/sync/transport/monolith-operation': `import { companyWorkbench, squireRow } from '@/test/company-workbench';
            const companies = companyWorkbench([{ ...squireRow(), section: 'attention', subtitle: '3 computers', status: 'Sign-in unavailable', attention: '1 computer needs attention', machines: [
              { id: 'working', name: 'Machine A', online: true, status: 'connected', signedInAs: 'owner@example.com', statusText: 'owner@example.com' },
              { id: 'failed', name: 'Machine B', online: true, status: 'connected', reconnecting: false, error: 'Google reconnect failed', statusText: 'Google sign-in expired' },
              { id: 'absent', name: 'Machine C', online: true, status: 'not-added', statusText: 'Google sign-in needed' }
            ] }]).companies;
            export class MonolithPhoneOperationError extends Error {}
            export const phoneOperationFailureReason = error => String(error.message);
            export const monolithPhoneOperation = async operation => operation === 'readWorkbench'
              ? { workspaceId: 'workspace', companies, connectors: [], connections: [], apps: [],
                  catalog: [{ connectorType: 'trusty-squire', name: 'Trusty Squire', available: true }],
                  helpers: [
                    { id: 'working', name: 'Machine A', online: true, squire: { status: 'connected', reportedAt: 1 } },
                    { id: 'failed', name: 'Machine B', online: true,
                      squire: { status: 'error', errorMessage: 'Squire broker unavailable', reportedAt: 1 } },
                    { id: 'absent', name: 'Machine C', online: true, squire: { status: 'not-added', reportedAt: 1 } }
                  ] } : {};`,
        } });
      expect(result.status, result.stderr).toBe(0);
      const proof = JSON.parse(result.result);
      expect(proof.page).toContain('Trusty Squire');
      expect(proof.page.match(/Trusty Squire/g)).toHaveLength(1);
      expect(proof.page).toContain('3 computers');
      expect(proof.page).toContain('Sign-in unavailable');
      expect(proof.page).not.toContain('Machine A');
      for (const name of ['Machine A', 'Machine B', 'Machine C']) expect(proof.service).toContain(name);
      expect(proof.service).toContain('owner@example.com');
      expect(proof.service).not.toContain('Ready');
      expect(proof.service).toContain('Google reconnect failed');
      expect(proof.service).toContain('Google sign-in expired');
      expect(proof.service).toContain('Google sign-in needed');
      expect(proof.service).not.toContain('Production API');
      expect(proof.sheet).not.toContain('Disconnect');
      expect(proof.destination).toMatchObject({ pathname: '/beeline/settings/workbench/connect',
        params: { connectorId: 'trusty-squire', helperId: 'failed' } });
      console.log(`Squire at ${width}px: one service; detail retains all three machine reports and broker errors`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90000);
});
