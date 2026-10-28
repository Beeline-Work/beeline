import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

/**
 * The real Connectors and info screens in the mobile web renderer. One tap on
 * a failed managed app opens one info page that holds its actions.
 * Its rows open no further page, and one Back leaves for Connectors.
 */
describe('failed managed app in the mobile web renderer', () => {
  it('opens one info page with its actions, and one Back returns to Connectors', async () => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/info-page-proof-'));
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(
        entry,
        `import React from 'react'; import { createRoot } from 'react-dom/client';
        Promise.all([import('@/app/(app)/beeline/settings/workbench'), import('@/app/(app)/beeline/settings/workbench/service')])
          .then(([{ default: Workbench }, { default: Service }]) => run(Workbench, Service))
          .catch(error => { document.getElementById('result').textContent = 'load error: ' + (error?.stack ?? error); });
        function run(Workbench, Service) {
          globalThis.__params = { workspaceId: 'ws', viewerId: 'viewer' };
          globalThis.__pushes = []; globalThis.__backs = 0; globalThis.__browser = [];
          const find = id => document.querySelector('[data-testid="' + id + '"]');
          const output = {};
          const root = createRoot(document.getElementById('root'));
          root.render(<Workbench />);
          setTimeout(() => {
            find('connectors-company-notion').click();
            setTimeout(() => {
              output.pushes = globalThis.__pushes.map(push => push.pathname);
              globalThis.__params = globalThis.__pushes[0].params;
              root.render(<Service />);
              setTimeout(() => {
                output.status = find('connector-info-status')?.textContent ?? null;
                output.appRow = find('company-item-notion-app')?.textContent ?? null;
                output.vault = find('connector-squire-vault')?.textContent ?? null;
                find('company-item-notion-key').click();
                find('company-item-notion-app').click();
                setTimeout(() => {
                  output.sheet = document.body.innerText.includes('Disconnect');
                  output.pushesAfterRows = globalThis.__pushes.length;
                  document.querySelector('[aria-label="Back to Connectors"]').click();
                  output.backs = globalThis.__backs;
                  document.getElementById('result').textContent = JSON.stringify(output);
                }, 300);
              }, 1200);
            }, 300);
          }, 1200);
        }`,
      );
      const result = await runBrowserProof({
        entry,
        mobile,
        width: 390,
        height: 844,
        budgetMs: 8000,
        shims: {
          ...webProofShims(mobile),
          '@expo/vector-icons': 'export const Ionicons = () => null;',
          'expo-web-browser': 'export const openAuthSessionAsync = async () => ({ type: "cancel" }); export const openBrowserAsync = async url => { globalThis.__browser.push(url); };',
          'expo-router': `import { useEffect } from 'react';
            export const useLocalSearchParams = () => globalThis.__params;
            export const useFocusEffect = effect => useEffect(() => effect(), [effect]);
            export const router = { back() { globalThis.__backs += 1; }, replace() {}, push(href) { globalThis.__pushes.push(href); } };`,
          '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithUrl: "https://monolith.test" });',
          '@/auth/auth-session': 'export const authSessionOptions = () => ({});',
          '@/buzz/wallet-workspace': 'export const resolveWalletWorkspaceId = async id => id || "ws";',
          '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => ({ publicKey: 'viewer' });
            export const getEffectiveRelayUrl = async () => 'https://monolith.test';`,
          '@/sync/transport/live-connection': 'export const sharedLiveConnection = () => ({ register: async () => () => undefined });',
          '@/sync/transport/monolith-operation': `import { companyWorkbench, companyRow } from '@/test/company-workbench';
            const notion = { ...companyRow('notion', 'Notion', 'attention'), subtitle: '1 app · 1 key', items: [
              { id: 'notion-app', title: 'Notion', subtitle: 'via Trusty Squire', kind: 'connection', target: { kind: 'app', appId: 'notion' }, state: 'connect', attention: true },
              { id: 'notion-key', title: 'Notion API', subtitle: 'api.notion.com', kind: 'key', target: { kind: 'key', connectionId: 'notion-key' } }] };
            export class MonolithPhoneOperationError extends Error {}
            export const phoneOperationFailureReason = error => String(error?.message ?? error);
            export const monolithPhoneOperation = async (operation) => {
              if (operation === 'readWorkbench') return { workspaceId: 'ws', companies: companyWorkbench([notion]).companies, helpers: [], connectors: [], connections: [], catalog: [],
                apps: [{ appId: 'notion', appKey: 'notion', name: 'Notion', domain: 'notion.so', transport: 'composio', route: 'composio', status: 'error',
                  helperId: 'laptop', helperName: 'Laptop', accountLabel: 'Owner', workspaceName: 'Work', useCount: 0, createdAt: 1 }] };
              return {};
            };`,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      console.log('Connected app info page:', result.result);
      const proof = JSON.parse(result.result);
      expect(proof.pushes).toEqual(['/beeline/settings/workbench/service']);
      expect(proof.status).toContain('Connect');
      expect(proof.appRow).toContain('Notion');
      expect(proof.vault).toContain('Manage in Trusty Squire');
      expect(proof.sheet).toBe(true);
      expect(proof.pushesAfterRows).toBe(1);
      expect(proof.backs).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90000);
});
