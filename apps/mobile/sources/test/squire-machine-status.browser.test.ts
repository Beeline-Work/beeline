import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

describe('Reproduction squire-machine-status-2 in Connectors', () => {
  it.each([390, 900])('renders each machine broker report without connector rows at %spx', async (width) => {
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
          output.page = document.querySelector('[data-testid="connectors-your-connections"]')?.textContent;
          globalThis.__params = { workspaceId: 'workspace', viewerId: 'owner',
            service: 'trusty-squire', helperId: 'failed' };
          root.render(<Service />);
        }, 1400);
        setTimeout(() => {
          output.service = document.querySelector('[data-testid="connector-service-screen"]')?.textContent;
          document.getElementById('result').textContent = JSON.stringify(output);
        }, 2600);`);
      const result = await runBrowserProof({ entry, mobile, width, budgetMs: 4000,
        screenshotPath: `/tmp/jellybean-squire-status-${width}.png`,
        shims: {
          ...webProofShims(mobile),
          '@expo/vector-icons': 'export const Ionicons = () => null;',
          'expo-router': `import { useEffect } from 'react';
            export const useLocalSearchParams = () => globalThis.__params;
            export const useFocusEffect = effect => useEffect(() => effect(), [effect]);
            export const router = { back() {}, push() {}, replace() {} };`,
          '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithUrl: "https://monolith.test" });',
          '@/auth/auth-session': 'export const authSessionOptions = () => ({});',
          '@/buzz/wallet-workspace': 'export const resolveWalletWorkspaceId = async () => "workspace";',
          '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => ({ publicKey: 'owner' });
            export const getEffectiveRelayUrl = async () => 'https://monolith.test';`,
          '@/sync/transport/live-connection': 'export const sharedLiveConnection = () => ({ register: async () => () => {} });',
          '@/sync/transport/monolith-operation': `export class MonolithPhoneOperationError extends Error {}
            export const phoneOperationFailureReason = error => String(error.message);
            export const monolithPhoneOperation = async operation => operation === 'readWorkbench'
              ? { workspaceId: 'workspace', connectors: [], connections: [], apps: [],
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
      expect(proof.page).toContain('Trusty Squire · Machine A');
      expect(proof.page).toContain('Connected');
      expect(proof.page).toContain('Trusty Squire · Machine B');
      expect(proof.page).toContain('Squire broker unavailable');
      expect(proof.page).toContain('Error');
      expect(proof.page).toContain('Trusty Squire · Machine C');
      expect(proof.page).toContain('Not added');
      expect(proof.service).toContain('Trusty Squire · Machine B');
      expect(proof.service).toContain('Squire broker unavailable');
      expect(proof.service).not.toContain('Connected');
      console.log(`Reproduction squire-machine-status-2 at ${width}px: three machine reports → Connected, Error with broker cause, Not added; selected failed machine stays Error`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90000);
});
