import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

/** A broken real connection reconnects directly from its visible list action. */
describe('failed managed app in the mobile web renderer', () => {
  it('starts sign-in from the list without a nested Disconnect flow', async () => {
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
              output.started = globalThis.__started;
              output.sheet = document.body.innerText.includes('Disconnect');
              document.getElementById('result').textContent = JSON.stringify(output);
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
          './app-sign-in': 'export const openAppSignIn=async()=>{};',
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
              if (operation === 'beginAppSignIn') { globalThis.__started=true; return {authorizationUrl:'https://example.invalid/sign-in'}; }
              return {};
            };`,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      console.log('Connected app info page:', result.result);
      const proof = JSON.parse(result.result);
      expect(proof.pushes).toEqual([]);
      expect(proof.started).toBe(true);
      expect(proof.sheet).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90000);
});
